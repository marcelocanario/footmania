import type { Club, Competition, Fixture, StandingsRow, World } from "./types";
import { createRng, shuffle } from "./rng";
import { MP_CONFIG } from "../config";

/** Bye placeholder for odd-sized fields (divisions are validated even; kept defensively). */
const BYE = -1;

/**
 * Deterministic tournament-style double round-robin schedule.
 *
 * Round structure (fixtures like an actual tournament):
 * - first half: every club meets every other club exactly once;
 * - second half: the same pairings repeat in the same round order with the
 *   venue flipped, so a return leg always comes exactly `clubs - 1` rounds
 *   after the first leg and no club ever faces the same opponent twice in a
 *   row.
 *
 * Pairings come from the circle method over a rotation of the club list that
 * is shuffled with an RNG derived from `seed`. Callers derive that seed from
 * stable competition identity (season + division), so regenerating a calendar
 * cannot reroll it while distinct seasons/divisions still vary.
 *
 * Venues are assigned by an exact dynamic program over rounds (state: each
 * club's previous-round venue) minimizing consecutive same-venue runs
 * ("breaks"), then home-count imbalance; very large fields fall back to a
 * linear-time greedy with the same guarantees apart from optimality. Perfect
 * H/A/H/A alternation is mathematically impossible in a complete round robin
 * (it would force every match to pair opposite-phase clubs, so same-phase
 * clubs could never meet); this deterministically reaches the achievable
 * minimum wherever the exact path runs.
 */
export function circleSchedule(seed: number, clubIds: number[]): [number, number][][] {
  const teams = shuffle(createRng(seed), [...clubIds]);
  const n = teams.length;
  const arr = n % 2 === 1 ? [...teams, BYE] : [...teams];
  const m = arr.length;
  const half = m / 2;

  // Unoriented rounds: pair each position against its mirror position, then
  // rotate every position except the first (circle method).
  const rounds: [number, number][][] = [];
  for (let r = 0; r < m - 1; r++) {
    const round: [number, number][] = [];
    for (let i = 0; i < half; i++) {
      round.push([arr[i], arr[m - 1 - i]]);
    }
    rounds.push(round);
    const last = arr.pop()!;
    arr.splice(1, 0, last);
  }

  const oriented = orientRoundsWithFewestBreaks(rounds);
  // Return legs: identical opponent order, flipped venues. Each return-leg
  // venue is the opposite of its first leg, so the second half repeats the
  // same near-alternating venue rhythm while no club can meet the same
  // opponent again until `clubs - 1` rounds have passed.
  return [...oriented, ...oriented.map((round) => round.map(([h, a]) => [a, h] as [number, number]))];
}

interface BreakDpEntry {
  /** Venue breaks so far (adjacent rounds with the same venue for one club). */
  cost: number;
  /** Summed |home count - ideal| across clubs, tie-break for fairness. */
  skew: number;
  /** Home counts per club index. */
  counts: number[];
  /** DP-map key of the predecessor state (previous round's home mask). */
  parentKey: number;
  /** Oriented pairs chosen for this round under this state. */
  pairs: [number, number][];
}

/**
 * Club-count cutoff between the exact break-minimizing DP and the linear-time
 * greedy orientation. Reachable DP states stay near 2^(clubs/2) because every
 * mask has exactly half the bits set, so the exact path costs milliseconds up
 * to this size and degrades quickly beyond it; divisions sit far below the
 * cutoff either way. Structural complexity bound, not a balance tunable.
 */
const EXACT_ORIENTATION_MAX_CLUBS = 16;

/**
 * Choose home/away orientation per match minimizing total venue breaks, then
 * home-count imbalance. Each match's orientation only couples its two clubs,
 * so for fields up to EXACT_ORIENTATION_MAX_CLUBS an exact DP over "which
 * clubs hosted last round" bitmasks finds the optimum; larger fields use a
 * deterministic greedy pass under the same behavioral contract (same
 * structural guarantees, slightly imperfect venue alternation).
 */
function orientRoundsWithFewestBreaks(rounds: [number, number][][]): [number, number][][] {
  if (rounds.length === 0) return [];
  const indexOf = new Map<number, number>();
  for (const round of rounds) {
    for (const [a, b] of round) {
      if (a !== BYE && !indexOf.has(a)) indexOf.set(a, indexOf.size);
      if (b !== BYE && !indexOf.has(b)) indexOf.set(b, indexOf.size);
    }
  }
  if (indexOf.size <= EXACT_ORIENTATION_MAX_CLUBS) return exactBreakDpOrientation(rounds, indexOf);
  return greedyBreakOrientation(rounds, indexOf);
}

/**
 * Exact DP: minimize total venue breaks (clubs repeating their previous
 * round's home OR away venue), then home-count imbalance. Every state mask
 * carries exactly half the bits, so reachable states stay near 2^(clubs/2);
 * bounded by EXACT_ORIENTATION_MAX_CLUBS this stays trivially cheap wherever
 * it runs.
 */
function exactBreakDpOrientation(rounds: [number, number][][], indexOf: Map<number, number>): [number, number][][] {
  const clubCount = indexOf.size;
  const mid = (clubCount - 1) / 2;
  const clubMask = (1 << clubCount) - 1;

  // Candidate orientations per round: bit j set -> the j-th pair hosts its
  // second club instead of its first. Bye pseudo-pairs keep their real club
  // and are ignored by costs (createLeagueFixtures skips them).
  const choicesPerRound = rounds.map((round) => {
    const choices: { homeMask: number; pairs: [number, number][] }[] = [];
    for (let choice = 0; choice < 1 << round.length; choice++) {
      let homeMask = 0;
      const pairs: [number, number][] = [];
      round.forEach(([a, b], j) => {
        if (a === BYE || b === BYE) {
          pairs.push([a === BYE ? b : a, BYE]);
          return;
        }
        const home = (choice >> j) & 1 ? b : a;
        const away = home === a ? b : a;
        homeMask |= 1 << indexOf.get(home)!;
        pairs.push([home, away]);
      });
      choices.push({ homeMask, pairs });
    }
    return choices;
  });

  const popCount = (mask: number): number => {
    let count = 0;
    while (mask) {
      mask &= mask - 1;
      count++;
    }
    return count;
  };

  const history: Map<number, BreakDpEntry>[] = [];
  let dp = new Map<number, BreakDpEntry>([
    [0, { cost: 0, skew: 0, counts: Array<number>(clubCount).fill(0), parentKey: -1, pairs: [] }],
  ]);
  for (const choices of choicesPerRound) {
    const next = new Map<number, BreakDpEntry>();
    for (const [key, entry] of dp) {
      for (const { homeMask, pairs } of choices) {
        // Clubs repeating their previous venue add one break each — both
        // hosting again and visiting again.
        const cost = entry.cost + popCount(homeMask & key) + popCount(~homeMask & ~key & clubMask);
        const counts = entry.counts.slice();
        for (const [home] of pairs) {
          if (home !== BYE) counts[indexOf.get(home)!]++;
        }
        const skew = counts.reduce((sum, c) => sum + Math.abs(c - mid), 0);
        const incumbent = next.get(homeMask);
        if (!incumbent || cost < incumbent.cost || (cost === incumbent.cost && skew < incumbent.skew)) {
          next.set(homeMask, { cost, skew, counts, parentKey: key, pairs });
        }
      }
    }
    history.push(next);
    dp = next;
  }

  // Deterministic final pick: least breaks, then least imbalance, then lowest mask.
  let bestKey = -1;
  let best: BreakDpEntry | undefined;
  for (const [key, entry] of dp) {
    if (
      !best ||
      entry.cost < best.cost ||
      (entry.cost === best.cost && entry.skew < best.skew) ||
      (entry.cost === best.cost && entry.skew === best.skew && (bestKey < 0 || key < bestKey))
    ) {
      bestKey = key;
      best = entry;
    }
  }

  // Walk the parent chain back to the start to recover each round's choice.
  const orientedRounds: [number, number][][] = [];
  let cursor = best!;
  for (let r = history.length - 1; r >= 0; r--) {
    orientedRounds[r] = cursor.pairs;
    if (r > 0) cursor = history[r - 1].get(cursor.parentKey)!;
  }
  return orientedRounds;
}

/** Improvement-sweep cap for the greedy orientation's local search. */
const GREEDY_ORIENTATION_MAX_SWEEPS = 16;

/**
 * Linear-time fallback for fields too large for the exact DP: orient each
 * match so clubs alternate venues where possible, then toward balanced home
 * counts, then toward the pair's first club, followed by deterministic
 * single-flip improvement sweeps (a flip is kept only when it strictly
 * reduces breaks, or keeps them equal while improving home-count balance).
 * Not optimal, but deterministic like every other fixture-generation decision
 * and far closer to the exact minimum than the raw pass alone.
 */
function greedyBreakOrientation(rounds: [number, number][][], indexOf: Map<number, number>): [number, number][][] {
  const HOME = 1;
  const AWAY = 0;
  const clubCount = indexOf.size;
  const mid = (clubCount - 1) / 2;
  const lastVenue = new Array<number>(clubCount).fill(-1);
  const homes = new Array<number>(clubCount).fill(0);
  // Initial pass: per match, pick the orientation causing fewer immediate
  // breaks, then balanced home counts, then the pair's first club.
  const oriented = rounds.map((round) =>
    round.map(([a, b]): [number, number] => {
      if (a === BYE || b === BYE) return [a === BYE ? b : a, BYE];
      const ia = indexOf.get(a)!;
      const ib = indexOf.get(b)!;
      const breaksIfAHosts = (lastVenue[ia] === HOME ? 1 : 0) + (lastVenue[ib] === AWAY ? 1 : 0);
      const breaksIfBHosts = (lastVenue[ib] === HOME ? 1 : 0) + (lastVenue[ia] === AWAY ? 1 : 0);
      let home = a;
      if (breaksIfBHosts < breaksIfAHosts || (breaksIfBHosts === breaksIfAHosts && homes[ib] < homes[ia])) home = b;
      lastVenue[home === a ? ia : ib] = HOME;
      lastVenue[home === a ? ib : ia] = AWAY;
      homes[home === a ? ia : ib]++;
      return [home, home === a ? b : a];
    })
  );

  // Venue grid the sweeps evaluate and mutate: venueOf[clubIndex][round].
  const venueOf = new Map<number, number[]>();
  for (const [, idx] of indexOf) venueOf.set(idx, Array<number>(rounds.length).fill(-1));
  oriented.forEach((round, r) =>
    round.forEach(([h, a]) => {
      if (h === BYE || a === BYE) return;
      venueOf.get(indexOf.get(h)!)![r] = HOME;
      venueOf.get(indexOf.get(a)!)![r] = AWAY;
    })
  );
  const homesByIndex = Array<number>(clubCount).fill(0);
  oriented.forEach((round) =>
    round.forEach(([h]) => {
      if (h !== BYE) homesByIndex[indexOf.get(h)!]++;
    })
  );

  const edgeBreaks = (ci: number, r: number): number => {
    let breaks = 0;
    if (r > 0 && venueOf.get(ci)![r] === venueOf.get(ci)![r - 1] && venueOf.get(ci)![r] !== -1) breaks++;
    if (r + 1 < rounds.length && venueOf.get(ci)![r] === venueOf.get(ci)![r + 1] && venueOf.get(ci)![r] !== -1) breaks++;
    return breaks;
  };

  for (let sweep = 0; sweep < GREEDY_ORIENTATION_MAX_SWEEPS; sweep++) {
    let improved = false;
    for (let r = 0; r < rounds.length; r++) {
      for (let j = 0; j < rounds[r].length; j++) {
        const pair = oriented[r][j];
        if (pair[0] === BYE || pair[1] === BYE) continue;
        const ia = indexOf.get(pair[0])!;
        const ib = indexOf.get(pair[1])!;
        const va = venueOf.get(ia)![r];
        const vb = venueOf.get(ib)![r];
        const before = edgeBreaks(ia, r) + edgeBreaks(ib, r);
        const skewBefore = Math.abs(homesByIndex[ia] - mid) + Math.abs(homesByIndex[ib] - mid);
        // Tentatively flip this match's orientation.
        venueOf.get(ia)![r] = vb;
        venueOf.get(ib)![r] = va;
        homesByIndex[ia] += vb === HOME ? 1 : -1;
        homesByIndex[ib] += va === HOME ? 1 : -1;
        const after = edgeBreaks(ia, r) + edgeBreaks(ib, r);
        const skewAfter = Math.abs(homesByIndex[ia] - mid) + Math.abs(homesByIndex[ib] - mid);
        if (after < before || (after === before && skewAfter < skewBefore)) {
          improved = true;
          oriented[r][j] = [pair[1], pair[0]];
        } else {
          // Revert the tentative flip.
          venueOf.get(ia)![r] = va;
          venueOf.get(ib)![r] = vb;
          homesByIndex[ia] -= vb === HOME ? 1 : -1;
          homesByIndex[ib] -= va === HOME ? 1 : -1;
        }
      }
    }
    if (!improved) break;
  }
  return oriented;
}

/**
 * Build one Fixture per real pairing of the schedule, one round per
 * `daysBetween` season days starting at `startDay`.
 *
 * `orderSeed` must derive from stable competition identity (season +
 * division ids), not from shared world RNG streams, so retries and restarts
 * reproduce the same calendar.
 */
export function createLeagueFixtures(
  orderSeed: number,
  competitionId: number,
  clubIds: number[],
  startDay: number,
  daysBetween: number
): Fixture[] {
  const rounds = circleSchedule(orderSeed, clubIds);
  const fixtures: Fixture[] = [];
  let id = 0;
  rounds.forEach((round, r) => {
    const day = startDay + r * daysBetween;
    for (const [home, away] of round) {
      if (home === -1 || away === -1) continue;
      fixtures.push({
        id: id++,
        competitionId,
        round: r,
        homeClubId: home,
        awayClubId: away,
        dayIndex: day,
        scheduledSeasonDayIndex: day,
        played: false,
      });
    }
  });
  return fixtures;
}

/** Validate the structural guarantees of a complete even-team double round robin. */
export function validateDoubleRoundRobinFixtures(fixtures: Fixture[], clubIds: number[], turns = 2): void {
  if (clubIds.length < 4 || clubIds.length % 2 !== 0) throw new Error("A division must contain an even number of at least four clubs");
  const rounds = turns * (clubIds.length - 1);
  const byRound = new Map<number, Fixture[]>();
  for (const fixture of fixtures) {
    const round = byRound.get(fixture.round) ?? [];
    round.push(fixture);
    byRound.set(fixture.round, round);
  }
  if (byRound.size !== rounds) throw new Error(`Expected ${rounds} rounds, got ${byRound.size}`);
  if (fixtures.length !== rounds * clubIds.length / 2) throw new Error("Fixture count does not form a complete round robin");

  const counts = new Map<number, { total: number; home: number; away: number }>();
  for (const id of clubIds) counts.set(id, { total: 0, home: 0, away: 0 });
  const pairs = new Map<string, { home: number; away: number }[]>();
  for (const fixture of fixtures) {
    const home = counts.get(fixture.homeClubId);
    const away = counts.get(fixture.awayClubId);
    if (!home || !away || fixture.homeClubId === fixture.awayClubId) throw new Error("Fixture contains an invalid club");
    home.total += 1;
    home.home += 1;
    away.total += 1;
    away.away += 1;
    const key = [fixture.homeClubId, fixture.awayClubId].sort((a, b) => a - b).join(":");
    const pair = pairs.get(key) ?? [];
    pair.push({ home: fixture.homeClubId, away: fixture.awayClubId });
    pairs.set(key, pair);
  }
  for (const value of counts.values()) {
    if (value.total !== rounds || value.home !== rounds / 2 || value.away !== rounds / 2) throw new Error("Club home/away balance is invalid");
  }
  if (pairs.size !== clubIds.length * (clubIds.length - 1) / 2 || [...pairs.values()].some((pair) => pair.length !== turns || new Set(pair.map((leg) => `${leg.home}:${leg.away}`)).size !== 2)) {
    throw new Error("Every pair must meet once at home and once away");
  }
}

export function emptyStandingsRow(clubId: number): StandingsRow {
  return { clubId, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 };
}

export function standingsTiebreak(rows: StandingsRow[], eloRatings?: ReadonlyMap<number, number>): StandingsRow[] {
  return [...rows].sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    if (a.wins !== b.wins) return b.wins - a.wins;
    const gdA = a.goalsFor - a.goalsAgainst;
    const gdB = b.goalsFor - b.goalsAgainst;
    if (gdA !== gdB) return gdB - gdA;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    const eloA = eloRatings?.get(a.clubId) ?? 0;
    const eloB = eloRatings?.get(b.clubId) ?? 0;
    if (eloA !== eloB) return eloB - eloA;
    return a.clubId - b.clubId;
  });
}

export function updateStandings(competition: Competition, homeId: number, awayId: number, hs: number, as: number) {
  if (competition.kind === "cup") return;
  const row = (id: number) => {
    competition.standings[id] ??= emptyStandingsRow(id);
    return competition.standings[id];
  };
  const hr = row(homeId);
  const ar = row(awayId);
  hr.played++;
  ar.played++;
  hr.goalsFor += hs;
  hr.goalsAgainst += as;
  ar.goalsFor += as;
  ar.goalsAgainst += hs;
  if (hs > as) {
    hr.wins++;
    hr.points += 3;
    ar.losses++;
  } else if (hs < as) {
    ar.wins++;
    ar.points += 3;
    hr.losses++;
  } else {
    hr.draws++;
    ar.draws++;
    hr.points++;
    ar.points++;
  }
}

export function sortedStandings(competition: Competition, eloRatings?: ReadonlyMap<number, number>): StandingsRow[] {
  const rows = Object.values(competition.standings);
  return standingsTiebreak(rows, eloRatings);
}

export function getPosition(competition: Competition, clubId: number, eloRatings?: ReadonlyMap<number, number>): number {
  const rows = sortedStandings(competition, eloRatings);
  const idx = rows.findIndex((r) => r.clubId === clubId);
  return idx < 0 ? 0 : idx + 1;
}

export function isLeagueFinished(competition: Competition, fixtures: Fixture[]): boolean {
  const clubs = competition.config.clubs;
  if (clubs.length === 0) return false;
  const maxRounds = competition.config.turns * (clubs.length - 1);
  const compFixtures = fixtures.filter((f) => f.competitionId === competition.id);
  const maxPlayed = Math.max(0, ...compFixtures.map((f) => (f.played ? f.round : -1)));
  return maxPlayed + 1 >= maxRounds;
}

// ---------------------------------------------------------------------------
// New-club sell lock (anti-funnel / anti-farm)
// ---------------------------------------------------------------------------

/**
 * League matches actually played by a club in the current season, counted from
 * played fixtures — deliberately NOT from StandingsRow.played /
 * MpClubSeason.played, which a mid-season joiner inherits from the replaced AI
 * club. Historical fixtures keep the retired AI's id, so fixture counting
 * correctly yields 0 for the joining club.
 */
export function matchesPlayedByClub(world: World, clubId: number): number {
  const activeDivisionIds = new Set(
    world.competitions
      .filter((c) => c.kind === "division" && c.status !== "ARCHIVED" && c.seasonId === world.mp.seasonId)
      .map((c) => c.id)
  );
  let played = 0;
  for (const f of world.fixtures) {
    if (!f.played || !activeDivisionIds.has(f.competitionId)) continue;
    if (f.homeClubId === clubId || f.awayClubId === clubId) played++;
  }
  return played;
}

/**
 * Outbound-market lock for fresh HUMAN clubs: a club may buy players and
 * release players immediately, but may not list players for transfer auction
 * or loan until it has played the configured number of its OWN league matches.
 * Filler AI clubs are exempt — they are ephemeral market supply, not
 * funnel participants. Returns an error string while locked, else null.
 */
export function newClubSellLockError(world: World, clubId: number): string | null {
  const club = world.clubs.find((c) => c.id === clubId);
  if (!club || club.ownerUserId === null) return null;
  const required = MP_CONFIG.newClubSellLockMatches;
  const played = matchesPlayedByClub(world, clubId);
  if (played >= required) return null;
  return `New clubs can sell or loan out players after ${required} played matches (${required - played} more to go)`;
}
