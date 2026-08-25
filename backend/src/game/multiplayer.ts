import type { Club, Competition, Fixture, MpClubSeasonEntry, Player, StandingsRow, World } from "./types";
import { createLeagueFixtures, emptyStandingsRow, standingsTiebreak, updateStandings, validateDoubleRoundRobinFixtures } from "./league";
import { simulateMatch } from "./match";
import { seasonKey, joinLockRound } from "./clock";
import { calendarValues, roundDayIndex } from "../services/seasonCalendar";
import { pickFixtureKickoff, pickSynchronizedKickoff, stableHash, type PreferenceInput } from "./scheduling";
import { ELO_CONFIG, gameConfig, MP_CONFIG } from "../config";
import { generateName } from "./names";
import { createRng, nextInt } from "./rng";
import { FEATURED_COUNTRIES } from "./countries";
import { overallFromSkills } from "./rating";
import { applyMatchElo, eloRatings } from "./elo";
import { releaseAllReservations, purgeClubBids, settleTransferAuction } from "./market";
import { generateFillerRoster, totalDivisionsForGeneration } from "./clubGenerator";
import { deriveAiKits } from "./kits";
import { NEWS_SUBJECTS, publishNews } from "./news";
import { recordActiveClubBoundaryChange } from "./population";

export const CLUBS_PER_DIVISION = gameConfig.league.teams;
export const ROUNDS_PER_SEASON = gameConfig.league.turns * (gameConfig.league.teams - 1);
export const MAX_DIVISIONS_PER_TIER = (tier: number) => (tier === 1 ? 1 : 1 << (tier - 1));

/** Division name in the plan's scheme: "1", "2.1", "3.2", ... */
export function divisionName(tier: number, groupIndex: number): string {
  if (tier === 1) return "1";
  return `${tier}.${groupIndex + 1}`;
}

/** Tier of a division competition. */
export function tierOf(comp: Competition): number {
  return comp.tier ?? 1;
}

export function groupIndexOf(comp: Competition): number {
  return comp.groupIndex ?? 0;
}

/** Division name for a competition object. */
export function compDivisionName(comp: Competition): string {
  return divisionName(tierOf(comp), groupIndexOf(comp));
}

/** Child divisions of a given division (groupIndex children, binary tree). */
export function childGroupIndexes(comp: Competition): number[] {
  return [groupIndexOf(comp) * 2, groupIndexOf(comp) * 2 + 1];
}

/** Is `child` the correct child of `parent`? */
export function isChildOf(parent: Competition, child: Competition): boolean {
  return tierOf(child) === tierOf(parent) + 1 && childGroupIndexes(parent).includes(groupIndexOf(child));
}

export function clubById(world: World, id: number): Club | undefined {
  return world.clubs.find((c) => c.id === id);
}

export function divisionById(world: World, id: number): Competition | undefined {
  return world.competitions.find((c) => c.kind === "division" && c.id === id);
}

export function divisionsInSeason(world: World, seasonId: number): Competition[] {
  return world.competitions.filter((c) => c.kind === "division" && c.seasonId === seasonId);
}

export function divisionsInTier(world: World, seasonId: number, tier: number): Competition[] {
  return divisionsInSeason(world, seasonId)
    .filter((c) => tierOf(c) === tier)
    .sort((a, b) => groupIndexOf(a) - groupIndexOf(b));
}

export function membersOf(world: World, divisionId: number): { clubId: number; isFillerAI: boolean; slot: number }[] {
  const comp = divisionById(world, divisionId);
  if (!comp) return [];
  return Object.values(comp.standings)
    .map((row) => ({ clubId: row.clubId, isFillerAI: isFillerAI(world, row.clubId), slot: row.clubId }))
    .sort((a, b) => a.slot - b.slot);
}

/** True when the club is a filler AI (no owner and never had one this season). */
export function isFillerAI(world: World, clubId: number): boolean {
  const club = clubById(world, clubId);
  return club !== undefined && club.ownerUserId === null && club.isHuman === false;
}

/** True when the club is owned by a human. */
export function isHumanClub(world: World, clubId: number): boolean {
  const club = clubById(world, clubId);
  return club !== undefined && club.ownerUserId !== null;
}

/** Ranked human clubs of a division, best-first by the plan's promotion rules. */
export function humanRanking(world: World, comp: Competition): { clubId: number; rank: number }[] {
  const rows = standingsTiebreak(Object.values(comp.standings), eloRatings(world));
  const humans = rows
    .filter((r) => isHumanClub(world, r.clubId))
    .map((r, i) => ({ clubId: r.clubId, rank: i + 1 }));
  return humans;
}

export function highestRankedReplaceableAI(world: World, comp: Competition): number | null {
  const rows = standingsTiebreak(Object.values(comp.standings), eloRatings(world));
  for (const row of rows) {
    const club = clubById(world, row.clubId);
    // Never replace a filler while its scheduled match is already live. The
    // fixture may be rewritten for future rounds, but the live state holds
    // the original club ids and would otherwise produce a split-brain result.
    const inLiveMatch = world.liveMatches.some((match) => match.homeClubId === row.clubId || match.awayClubId === row.clubId);
    if (club && club.ownerUserId === null && club.isHuman === false && !inLiveMatch) return row.clubId;
  }
  return null;
}

/** Count of filler AI clubs in a division. */
export function fillerCount(world: World, comp: Competition): number {
  return Object.values(comp.standings).filter((r) => isFillerAI(world, r.clubId)).length;
}

export function humanCount(world: World, comp: Competition): number {
  return Object.values(comp.standings).filter((r) => isHumanClub(world, r.clubId)).length;
}

/** All clubs currently in the active pyramid (ACTIVE + a competition membership). */
export function activeClubs(world: World): Club[] {
  const ids = new Set<number>();
  for (const c of world.competitions) {
    if (c.kind === "division" && c.status !== "ARCHIVED") {
      for (const row of Object.values(c.standings)) ids.add(row.clubId);
    }
  }
  return world.clubs.filter((c) => ids.has(c.id));
}

export function activeDivisionForClub(world: World, clubId: number): Competition | undefined {
  return world.competitions.find((c) => c.kind === "division" && c.status !== "ARCHIVED" && c.standings[clubId] !== undefined);
}

/** Resolve the current pyramid tier, falling back to the latest known season. */
export function divisionForClub(world: World, clubId: number): number {
  const active = activeDivisionForClub(world, clubId);
  if (active) return tierOf(active);
  const history = world.mpClubSeasons
    .filter((entry) => entry.clubId === clubId)
    .sort((a, b) => b.seasonId - a.seasonId);
  return history[0]?.tier ?? 1;
}

/**
 * Record a club's division for the season it is about to play. The highest-ever
 * division reached only updates once the club actually enters a higher division
 * (lower number), never merely when promotion is secured (player-generation
 * §21). Division 1 = strongest; larger numbers are weaker.
 */
export function recordDivision(world: World, clubId: number, division: number): void {
  const club = clubById(world, clubId);
  if (club) club.highestDivision = Math.min(club.highestDivision, division);
}

/**
 * Set the first real competitive division for a newly created club. New clubs
 * receive a roster before placement, so their provisional generation context
 * must not be treated as a historical Division-1 achievement.
 */
export function recordInitialDivision(world: World, clubId: number, division: number): void {
  const club = clubById(world, clubId);
  if (!club) return;
  const creationKey = `club-creation:${clubId}`;
  const hasPriorSeason = world.mpClubSeasons.some((entry) => entry.clubId === clubId);
  if (world.generationEvents.includes(creationKey) && !hasPriorSeason) club.highestDivision = division;
  else recordDivision(world, clubId, division);
}

export function auditMultiplayerEvent(
  world: World,
  eventType: string,
  opts: { clubId?: number | null; userId?: number | null; metadata?: string } = {},
): void {
  world.mpAudits.push({
    seasonId: world.mp.seasonId || null,
    clubId: opts.clubId ?? null,
    userId: opts.userId ?? null,
    eventType,
    occurredAt: Date.now(),
    metadata: opts.metadata ?? null,
  });
}

export function lowestActiveTier(world: World, seasonId: number): number {
  const tiers = divisionsInSeason(world, seasonId).map(tierOf);
  return tiers.length === 0 ? 1 : Math.max(...tiers);
}

/** Replaceable AI slot in the first (lowest-group) division of a tier, or null. */
export function firstReplaceableAIDivision(world: World, seasonId: number, tier: number): Competition | null {
  const divs = divisionsInTier(world, seasonId, tier);
  for (const d of divs) {
    if (highestRankedReplaceableAI(world, d) !== null) return d;
  }
  return null;
}

/** Create a filler AI club with its fixed generated squad (invariant #28). */
export function createFillerAI(world: World, tier: number, seasonId?: number): Club {
  const rng = world.rng;
  const id = world.nextId++;
  const city = pickCity(rng);
  const name = `${city} FC`;
  const country = FEATURED_COUNTRIES[nextInt(rng, FEATURED_COUNTRIES.length)].code;
  // Kit Lab: fillers wear their deterministic palette-derived designs; the
  // identity columns mirror the home shell so color readers stay consistent.
  const kits = deriveAiKits(id);
  const club: Club = {
    id,
    name,
    shortName: name,
    ownerUserId: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country,
    highestDivision: tier,
    // Ephemeral AI clubs have no finances: cash stays 0 and nothing is ever
    // charged or paid to them (invariant #28).
    cash: 0,
    stadiumName: `${city} Stadium`,
    kits,
    primaryColor: kits.home.primary,
    secondaryColor: kits.home.secondary,
    coachName: generateName(rng, country),
    tactics: randomTactics(rng),
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
    eloRating: ELO_CONFIG.initial,
    eloRatedMatches: 0,
  };
  world.clubs.push(club);
  generateFillerRoster({
    world,
    club,
    currentDivision: tier,
    highestDivisionReached: tier,
    totalDivisions: totalDivisionsForGeneration(world, seasonId),
    seasonId: (seasonId ?? world.mp.seasonId) || null,
  });
  return club;
}

function pickCity(rng: ReturnType<typeof createRng>): string {
  const cities = [
    "London", "Madrid", "Rome", "Munich", "Paris", "Lisbon", "Amsterdam", "Brussels",
    "Vienna", "Zurich", "Stockholm", "Dublin", "Warsaw", "Prague", "Budapest", "Athens",
    "Istanbul", "Kyiv", "Buenos Aires", "Montevideo", "Santiago", "Lima", "Bogota", "Mexico City",
    "New York", "Los Angeles", "Chicago", "Toronto", "Tokyo", "Seoul", "Shanghai", "Mumbai",
  ];
  return cities[nextInt(rng, cities.length)];
}

/**
 * Deterministic clean club-name suggestion for moderation resets. Uses the
 * same city + "FC" pattern as filler AI clubs so a reset name always fits the
 * pyramid; `attempt` varies the outcome deterministically (no hidden reroll).
 */
export function suggestedModerationClubName(attempt: number): string {
  const seed = Math.imul(Math.max(0, attempt) + 1, 0x9e3779b1) >>> 0;
  return `${pickCity(createRng(seed))} FC`;
}

function randomTactics(rng: ReturnType<typeof createRng>) {
  const roll = nextInt(rng, 100);
  return {
    formation: roll <= 2 ? 0 : roll <= 4 ? 1 : roll <= 7 ? 2 : roll <= 38 ? 3 : roll <= 49 ? 4 : roll <= 60 ? 5 : roll <= 65 ? 6 : roll <= 72 ? 7 : roll <= 90 ? 8 : roll <= 92 ? 9 : 10,
    style: nextInt(rng, 100) <= 5 ? 2 : nextInt(rng, 100) <= 70 ? 0 : 1,
    pressing: nextInt(rng, 100) <= 70 ? 0 : 1,
    direction: nextInt(rng, 100) <= 70 ? 0 : 1,
  };
}

export interface SeasonContext {
  seasonId: number;
  year: number;
  month: number;
}

/** Create a new global season (competition = Division 1 with 8 filler AI). */
export function initSeason(world: World, ref: { year: number; month: number }, seasonId: number): SeasonContext {
  world.mp.seasonId = seasonId;
  world.mp.seasonYear = ref.year;
  world.mp.seasonMonth = ref.month;
  world.mp.seasonStatus = "ACTIVE";
  world.mp.completedRounds = 0;
  world.mp.joinLockRound = joinLockRound();
  world.mp.joinState = "OPEN";
  world.mp.joinThresholdPercent = MP_CONFIG.joinThresholdPercent;
  world.mp.seasonNumber = world.mp.seasonNumber ?? Math.max(1, world.year);
  world.mp.seasonDayIndex = 0;
  world.mp.absoluteGameDay = world.mp.absoluteGameDay ?? 0;
  world.mp.startAbsoluteGameDay = world.mp.absoluteGameDay;
  if (world.mp.seasonStartAt === null || world.mp.seasonStartAt === undefined) {
    const now = new Date();
    world.mp.seasonStartAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  world.mp.phase = "ACTIVE";

  // Ensure a Division 1 exists. All pre-existing clubs stay; on first run the
  // world is empty and we create 8 filler AI clubs.
  const existing = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId);
  if (existing) {
    // Ensure fixtures exist for the division if they don't already.
    const hasFixtures = world.fixtures.some((f) => f.competitionId === existing.id);
    if (!hasFixtures && Object.keys(existing.standings).length > 0) {
      const fixtures = generateDivisionFixtures(world, existing, ref);
      world.fixtures.push(...fixtures);
    }
    return { seasonId, year: ref.year, month: ref.month };
  }

  const div = createDivision(world, { tier: 1, groupIndex: 0, seasonId, ref });
  // Fill with filler AI until 8 slots.
  ensureDivisionFull(world, div);
  const fixtures = generateDivisionFixtures(world, div, ref);
  world.fixtures.push(...fixtures);
  div.status = "ACTIVE";
  return { seasonId, year: ref.year, month: ref.month };
}

/** Create a division (competition) with empty standings + no fixtures yet. */
export function createDivision(
  world: World,
  opts: { tier: number; groupIndex: number; seasonId: number; ref: { year: number; month: number } }
): Competition {
  const id = world.nextId++;
  const comp: Competition = {
    id,
    kind: "division",
    name: divisionName(opts.tier, opts.groupIndex),
    round: 0,
    stage: "group",
    seasonId: opts.seasonId,
    tier: opts.tier,
    groupIndex: opts.groupIndex,
    status: "CREATING",
    config: { clubs: [], turns: gameConfig.league.turns, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
    standings: {},
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
  world.competitions.push(comp);
  return comp;
}

/** Division state machine (plan §57): CREATING → SIMULATING_HISTORY → ACTIVE. */
export function setDivisionState(world: World, divisionId: number, state: "CREATING" | "SIMULATING_HISTORY" | "ACTIVE" | "COMPLETE" | "ARCHIVED"): void {
  const comp = divisionById(world, divisionId);
  if (comp) comp.status = state;
}

/**
 * Generate the 14-round schedule for a division and assign kickoff timestamps.
 *
 * Kickoffs are optimized inside the clubs' preferred half-hour windows while
 * game days/rounds stay fixed (see game/scheduling.ts):
 * - ordinary rounds are optimized per fixture (home preference first, then
 *   the away club's, ties resolved by the stable seeded spread);
 * - the last round is synchronized per division/group: one shared instant
 *   minimizes summed home distance, then summed away distance;
 * - AI fillers and legacy humans without preferences are unconstrained.
 * Fixtures are only timed here, at generation; they are never rescheduled
 * afterwards (mid-season joins inherit existing kickoffs unchanged).
 */
export function generateDivisionFixtures(world: World, comp: Competition, ref: { year: number; month: number }): Fixture[] {
  void ref;
  const clubIds = Object.keys(comp.standings).map(Number);
  // Calendar order is seeded from stable competition identity (season +
  // division), never from shared world RNG streams, so regeneration retries
  // reproduce the same tournament calendar.
  const orderSeed = stableHash(`${comp.seasonId}:${comp.id}`);
  const fixtures = createLeagueFixtures(orderSeed, comp.id, clubIds, gameConfig.league.startDay, gameConfig.matchSpacingDays);
  const seasonStart = world.mp.seasonStartAt ?? Date.now();
  const prefOf = (clubId: number): PreferenceInput => {
    const club = clubById(world, clubId);
    return { preferredSlots: club?.preferredHours ?? null };
  };
  const byRound = new Map<number, Fixture[]>();
  for (const f of fixtures) {
    const list = byRound.get(f.round) ?? [];
    list.push(f);
    byRound.set(f.round, list);
  }
  const lastRound = fixtures.reduce((max, f) => Math.max(max, f.round), 0);
  for (const [round, roundFixtures] of byRound) {
    const dayStart = seasonStart + roundDayIndex(round) * 24 * 60 * 60 * 1000;
    if (round === lastRound) {
      // Seed from stable identity so retries cannot reroll kickoffs.
      const kickoff = pickSynchronizedKickoff(roundFixtures.map((f) => ({ home: prefOf(f.homeClubId), away: prefOf(f.awayClubId) })), dayStart, `${comp.id}:${round}`);
      for (const f of roundFixtures) f.kickoffAt = kickoff;
    } else {
      for (const f of roundFixtures) f.kickoffAt = pickFixtureKickoff(prefOf(f.homeClubId), prefOf(f.awayClubId), dayStart, `${comp.id}:${round}:${f.homeClubId}:${f.awayClubId}`);
    }
  }
  for (const f of fixtures) {
    f.id = world.nextId++;
  }
  validateDoubleRoundRobinFixtures(fixtures, clubIds, gameConfig.league.turns);
  comp.config.clubs = clubIds;
  return fixtures;
}

/** Simulate a division through the current global round (used when creating it mid-season). */
export function simulateDivisionThroughRound(world: World, comp: Competition, throughRound: number, now: number) {
  if (comp.status === "CREATING") comp.status = "SIMULATING_HISTORY";
  const fixtures = world.fixtures.filter((f) => f.competitionId === comp.id && !f.played);
  const target = Math.min(throughRound, ROUNDS_PER_SEASON);
  for (const f of fixtures) {
    const round = f.round + 1;
    if (round > target) break;
    if (world.mp.manualRound === null && f.kickoffAt !== undefined && f.kickoffAt > now) continue;
    const home = clubById(world, f.homeClubId);
    const away = clubById(world, f.awayClubId);
    if (!home || !away) continue;
    const sim = simulateMatch(world.rng, home, away, world.players, {
      competitionId: comp.id,
      fixtureId: f.id,
      homeNeutral: false,
      decider: false,
      compKind: "division",
      year: world.mp.seasonYear,
      // Real fixtures simulated instantly must anchor injuries to the current
      // absolute game day; without this they would expire immediately.
      absoluteGameDay: world.mp.absoluteGameDay ?? world.dayIndex,
      roundsPerSeason: calendarValues().roundsPerSeason,
      matchSpacingDays: calendarValues().matchSpacingDays,
    });
    f.played = true;
    world.matches.push({
      id: world.nextId++,
      fixtureId: f.id,
      competitionId: comp.id,
      homeClubId: f.homeClubId,
      awayClubId: f.awayClubId,
      homeScore: sim.homeGoals,
      awayScore: sim.awayGoals,
      penaltyWinnerId: null,
      events: sim.match.events,
      stats: sim.match.stats,
      extraTime: false,
        minuteEvents: [],
        homeWasHuman: home.ownerUserId !== null,
        awayWasHuman: away.ownerUserId !== null,
        eloProcessed: false,
      });
    applyMatchElo(world, world.matches[world.matches.length - 1]);
    updateStandings(comp, f.homeClubId, f.awayClubId, sim.homeGoals, sim.awayGoals);
  }
  if (comp.status === "SIMULATING_HISTORY") comp.status = "ACTIVE";
}

/**
 * Admin manual clock: simulate every active division instantly through
 * `targetRound`, then set the season's completed-round counter and join lock.
 * This lets an admin test a full season without waiting for real kickoffs.
 * While `manualRound` stays set, the manual value is authoritative over the
 * real clock. Any in-progress live matches are discarded so the simulation
 * through the target round is consistent.
 */
export function simulateThroughRound(world: World, targetRound: number, now: number): number {
  // Manual time is forward-only. Rewinding the counter without rewinding
  // fixtures would make the persisted season claim rounds are still pending
  // after their matches have already been simulated.
  const target = Math.max(world.mp.completedRounds, Math.min(ROUNDS_PER_SEASON, Math.round(targetRound)));
  // Discard in-progress live matches: they belong to the real schedule and
  // would otherwise race with the instant simulation below.
  world.liveMatches = [];
  for (const club of world.clubs) club.liveMatchAt = null;
  // Mark manual timing before simulating so the shared division handler does
  // not reject future real-time kickoffs during an explicit admin advance.
  world.mp.manualRound = target;
  const divisions = world.competitions.filter((c) => c.kind === "division" && c.status !== "ARCHIVED");
  for (const div of divisions) {
    simulateDivisionThroughRound(world, div, target, now);
  }
  world.mp.completedRounds = target;
  if (target >= world.mp.joinLockRound) world.mp.joinState = "LOCKED";
  return target;
}

/** Add filler AI until a division has exactly 8 clubs. */
export function ensureDivisionFull(world: World, comp: Competition): number {
  const existing = Object.keys(comp.standings).map(Number);
  const needed = CLUBS_PER_DIVISION - existing.length;
  for (let i = 0; i < needed; i++) {
    const ai = createFillerAI(world, tierOf(comp), comp.seasonId);
    comp.standings[ai.id] = emptyStandingsRow(ai.id);
  }
  return needed;
}

/** Replace a club within a division's record with a new club (AI replacement). */
export function replaceClubInDivision(world: World, comp: Competition, oldClubId: number, newClubId: number) {
  const row = comp.standings[oldClubId];
  if (!row) return;
  delete comp.standings[oldClubId];
  row.clubId = newClubId;
  comp.standings[newClubId] = row;
  comp.config.clubs = Object.keys(comp.standings).map(Number);
  recordInitialDivision(world, newClubId, tierOf(comp));
  // Historical fixtures keep their original club IDs; only future fixtures get
  // the new identity.
  for (const f of world.fixtures) {
    if (f.competitionId !== comp.id || f.played) continue;
    if (f.homeClubId === oldClubId) f.homeClubId = newClubId;
    if (f.awayClubId === oldClubId) f.awayClubId = newClubId;
  }
}

/**
 * Remove an ephemeral filler after a human takes its competition slot.
 *
 * Market reconciliation happens BEFORE the roster is destroyed (plan §102.9):
 *  1. the filler's own bids/evaluations/reservations are voided, so a club
 *     that is about to disappear can neither win nor influence any other
 *     listing's proxy state;
 *  2. its active transfer listings with surviving bids are force-settled —
 *     the leading bidder wins the player immediately at the proxy clearing
 *     price; listings without bids are cancelled and released;
 *  3. only then is the remaining squad deleted, so a force-settled player
 *     travels to its winner instead of being destroyed with the club.
 */
function retireFillerClub(world: World, clubId: number, now: number): void {
  const club = clubById(world, clubId);
  if (!club || club.ownerUserId !== null || club.isHuman) return;
  const squadIds = new Set(world.players.filter((player) => player.clubId === clubId).map((player) => player.id));
  const loanIds = new Set(world.loans.filter((loan) => loan.fromClubId === clubId || loan.toClubId === clubId).map((loan) => loan.id));

  // 1. Void the filler's own market commitments first.
  purgeClubBids(world, clubId);

  // 2. Resolve the filler's own listings while it still exists.
  for (const listing of [...world.transferAuctions]) {
    if (listing.status !== "ACTIVE" || (listing.sellerClubId !== clubId && !squadIds.has(listing.playerId))) continue;
    const hasBids = world.marketBids.some((bid) => bid.marketType === "TRANSFER" && bid.listingId === listing.id);
    if (hasBids) {
      // Force-close: the seller is disappearing, so the leading surviving
      // bidder wins now at the proxy clearing price (never its maximum).
      const settled = settleTransferAuction(world, listing, now, { forceClose: true });
      if (settled.ok) continue;
    }
    // No (valid) bids: fail closed like the worker path — cancel, release,
    // clear the flag. The player is destroyed with the club below.
    releaseAllReservations(world, listing.id, "TRANSFER");
    listing.status = "CANCELLED";
    listing.cancelledAt = now;
    const player = world.players.find((candidate) => candidate.id === listing.playerId);
    if (player) player.onSale = false;
    if (hasBids) {
      publishNews(world, {
        kind: "auction",
        text: `The auction for ${player?.name ?? "a player"} was cancelled because it could not be settled`,
      });
    }
  }
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE" || !squadIds.has(listing.playerId)) continue;
    // Defensive: a squad player cannot have a free-agent listing (such a
    // player would be unowned). Cancel-and-release if state ever contradicts.
    releaseAllReservations(world, listing.id, "FREE_AGENT");
    listing.status = "CANCELLED";
    listing.completedAt = now;
  }

  // 3. Detach players loaned out by/in to the filler.
  for (const player of world.players) {
    if (player.loanId !== null && loanIds.has(player.loanId) && !squadIds.has(player.id)) {
      player.loanId = null;
      player.clubId = null;
      player.starter = false;
      player.tacPos = -1;
    }
  }

  // 4. Destroy the remaining roster and the club. Force-settled players now
  //    belong to their winners and survive.
  world.players = world.players.filter((player) => player.clubId !== clubId);
  world.loans = world.loans.filter((loan) => !loanIds.has(loan.id));
  world.clubs = world.clubs.filter((candidate) => candidate.id !== clubId);
}

/** Placement result for a joining human. */
export type JoinResult =
  | { kind: "active"; divisionId: number; tier: number; position: number; replacedClubId: number }
  | { kind: "provisional"; seasonKey: string };

/**
 * Place a newly created human club into the current season (before the join
 * lock) or mark it provisional for next season (plan §11/§14/§62).
 *
 * The authoritative join gate is the transactionally stored mp state
 * (completedRounds / joinState), NOT the wall clock (plan §82).
 */
export function placeNewClub(world: World, clubId: number, now: number, seasonId: number, nextSeasonRef: { year: number; month: number }): JoinResult {
  if (world.mp.completedRounds >= world.mp.joinLockRound || world.mp.joinState === "LOCKED") {
    world.mp.joinState = "LOCKED";
    clubById(world, clubId)!.competitionState = "PROVISIONAL";
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }

  const ref = { year: world.mp.seasonYear, month: world.mp.seasonMonth };
  const lowestTier = lowestActiveTier(world, seasonId);
  let division = firstReplaceableAIDivision(world, seasonId, lowestTier);
  if (!division) {
    // Create the next allowed division at the lowest tier, or the next tier.
    const divs = divisionsInTier(world, seasonId, lowestTier);
    const nextGroup = divs.length;
    if (nextGroup < MAX_DIVISIONS_PER_TIER(lowestTier)) {
      division = createDivision(world, { tier: lowestTier, groupIndex: nextGroup, seasonId, ref });
    } else {
      const newTier = lowestTier + 1;
      division = createDivision(world, { tier: newTier, groupIndex: 0, seasonId, ref });
    }
    ensureDivisionFull(world, division);
    const fixtures = generateDivisionFixtures(world, division, ref);
    world.fixtures.push(...fixtures);
    simulateDivisionThroughRound(world, division, world.mp.completedRounds, now);
  }

  const aiId = highestRankedReplaceableAI(world, division);
  if (aiId === null) {
    // Shouldn't happen after fill + simulation; fall back to provisional.
    clubById(world, clubId)!.competitionState = "PROVISIONAL";
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }
  const ai = clubById(world, aiId)!;
  const position = positionInDivision(world, division, aiId);
  replaceClubInDivision(world, division, aiId, clubId);
  const club = clubById(world, clubId)!;
  retireFillerClub(world, aiId, now);
  club.competitionState = "ACTIVE";
  // The new club now enters the active persistent boundary: its target
  // contribution minus the generated stock it arrived with goes into the ledger.
  // Recorded here, NOT at creation, because a late joiner stays PROVISIONAL
  // (outside the boundary) until this moment.
  recordActiveClubBoundaryChange(
    world,
    world.players.filter((p) => p.clubId === club.id).length,
    1,
  );
  // The human club inherits only current-season competition state; it keeps
  // its own identity, roster, finances, facilities.
  publishNews(world, {
    kind: "mp",
    subject: NEWS_SUBJECTS.clubStatus,
    clubId: club.id,
    headline: "Pyramid standing",
    entries: [{ key: `join:${club.id}`, label: club.name, detail: `joined ${division.name}` }],
  });
  return { kind: "active", divisionId: division.id, tier: tierOf(division), position, replacedClubId: aiId };
}

function positionInDivision(world: World, comp: Competition, clubId: number): number {
  const rows = standingsTiebreak(Object.values(comp.standings), eloRatings(world));
  const idx = rows.findIndex((r) => r.clubId === clubId);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * Re-activate a DORMANT club (plan §46/§48). Before the join lock the club is
 * placed into the lowest active division with a replaceable AI slot (it does
 * not reclaim its historical tier). After the lock it becomes PROVISIONAL and
 * is queued for the next season. It never receives a new-club startup package.
 */
export function returnDormantClub(world: World, clubId: number, now: number, seasonId: number, nextSeasonRef: { year: number; month: number }): JoinResult {
  const club = clubById(world, clubId);
  if (!club || club.competitionState !== "DORMANT") {
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }
  if (world.mp.completedRounds >= world.mp.joinLockRound || world.mp.joinState === "LOCKED") {
    world.mp.joinState = "LOCKED";
    club.competitionState = "PROVISIONAL";
    club.abandonmentEligibleAt = null;
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }

  const ref = { year: world.mp.seasonYear, month: world.mp.seasonMonth };
  const lowestTier = lowestActiveTier(world, seasonId);
  let division = firstReplaceableAIDivision(world, seasonId, lowestTier);
  if (!division) {
    const divs = divisionsInTier(world, seasonId, lowestTier);
    const nextGroup = divs.length;
    if (nextGroup < MAX_DIVISIONS_PER_TIER(lowestTier)) {
      division = createDivision(world, { tier: lowestTier, groupIndex: nextGroup, seasonId, ref });
    } else {
      const newTier = lowestTier + 1;
      division = createDivision(world, { tier: newTier, groupIndex: 0, seasonId, ref });
    }
    ensureDivisionFull(world, division);
    const fixtures = generateDivisionFixtures(world, division, ref);
    world.fixtures.push(...fixtures);
    simulateDivisionThroughRound(world, division, world.mp.completedRounds, now);
  }

  const aiId = highestRankedReplaceableAI(world, division);
  if (aiId === null) {
    club.competitionState = "PROVISIONAL";
    club.abandonmentEligibleAt = null;
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }
  const position = positionInDivision(world, division, aiId);
  replaceClubInDivision(world, division, aiId, clubId);
  retireFillerClub(world, aiId, now);
  club.competitionState = "ACTIVE";
  // The frozen roster re-enters the active boundary together with the club's
  // target contribution. The signed gap between the two goes into the ledger —
  // recorded only once the club actually becomes ACTIVE (a dormant return that
  // falls back to PROVISIONAL above records nothing).
  recordActiveClubBoundaryChange(world, world.players.filter((p) => p.clubId === club.id).length, 1);
  club.abandonmentEligibleAt = null;
  club.lastMeaningfulActivityAt = Date.now();
  publishNews(world, {
    kind: "mp",
    subject: NEWS_SUBJECTS.clubStatus,
    clubId: club.id,
    headline: "Pyramid standing",
    entries: [{ key: `return:${club.id}`, label: club.name, detail: `returned to the pyramid in ${division.name}` }],
  });
  return { kind: "active", divisionId: division.id, tier: tierOf(division), position, replacedClubId: aiId };
}

// ---------------------------------------------------------------------------
// Rollover / promotion / relegation (plan §23-§35, §58-§61)
// ---------------------------------------------------------------------------

export interface TierAssignment {
  clubId: number;
  targetTier: number;
  finishPosition: number;
  previousDivision: string;
}

export interface PromotionCandidate {
  clubId: number;
  humanRank: number;
  row: StandingsRow;
  eloRating: number;
}

/** Cross-group promotion ordering used after every group's automatic winner. */
export function promotionCandidateTiebreak(a: PromotionCandidate, b: PromotionCandidate): number {
  if (b.eloRating !== a.eloRating) return b.eloRating - a.eloRating;
  const matchesA = a.row.played;
  const matchesB = b.row.played;
  const ppgA = matchesA === 0 ? 0 : a.row.points / matchesA;
  const ppgB = matchesB === 0 ? 0 : b.row.points / matchesB;
  if (ppgB !== ppgA) return ppgB - ppgA;
  const gdA = matchesA === 0 ? 0 : (a.row.goalsFor - a.row.goalsAgainst) / matchesA;
  const gdB = matchesB === 0 ? 0 : (b.row.goalsFor - b.row.goalsAgainst) / matchesB;
  if (gdB !== gdA) return gdB - gdA;
  const gfA = matchesA === 0 ? 0 : a.row.goalsFor / matchesA;
  const gfB = matchesB === 0 ? 0 : b.row.goalsFor / matchesB;
  if (gfB !== gfA) return gfB - gfA;
  const winsA = matchesA === 0 ? 0 : a.row.wins / matchesA;
  const winsB = matchesB === 0 ? 0 : b.row.wins / matchesB;
  if (winsB !== winsA) return winsB - winsA;
  return a.clubId - b.clubId;
}

/** Record a meaningful-activity audit row (plan §40/§55) and refresh the club's
 *  last activity timestamp used by abandonment evaluation. */
export function recordActivity(world: World, userId: number, clubId: number, activityType: string, metadata?: string): void {
  const now = Date.now();
  world.mpActivities.push({ userId, clubId, activityType, occurredAt: now, metadata: metadata ?? null });
  const club = clubById(world, clubId);
  if (club) {
    club.lastMeaningfulActivityAt = now;
    club.abandonmentEligibleAt = null;
  }
}

/** Inactivity threshold (days) for a club's current tier (plan §41). */
export function inactivityThresholdFor(world: World, clubId: number): number {
  const club = clubById(world, clubId);
  if (!club) return MP_CONFIG.inactivityThresholds.default;
  const division = activeDivisionForClub(world, clubId);
  const tier = division ? tierOf(division) : 1;
  const byTier = MP_CONFIG.inactivityThresholds;
  return byTier[tier as keyof typeof byTier] ?? byTier.default;
}

/**
 * Daily abandonment evaluation (plan §40/§42). Clubs that have not had a
 * meaningful action within their tier's threshold are flagged
 * `abandonmentEligibleAt`; meaningful activity clears the flag. Clubs are
 * NEVER removed mid-season — the flag is only consumed at rollover.
 */
export function evaluateInactivity(world: World, now: number): void {
  for (const club of world.clubs) {
    if (club.ownerUserId === null) continue;
    if (club.competitionState !== "ACTIVE") continue;
    const thresholdDays = inactivityThresholdFor(world, club.id);
    const last = club.lastMeaningfulActivityAt;
    if (last === null) {
      // No recorded activity yet: treat club creation as the anchor.
      club.lastMeaningfulActivityAt = now;
      continue;
    }
    const daysInactive = (now - last) / (24 * 60 * 60 * 1000);
    if (daysInactive >= thresholdDays) {
      if (club.abandonmentEligibleAt === null) {
        club.abandonmentEligibleAt = now;
        publishNews(world, {
          kind: "mp",
          subject: NEWS_SUBJECTS.clubStatus,
          recipientClubId: club.id,
          headline: "Inactivity warning",
          entries: [{ key: `inactive:${club.id}`, label: club.name, detail: "has been inactive and may be removed at season end" }],
        });
      }
    } else {
      club.abandonmentEligibleAt = null;
    }
  }
}

/**
 * Rebuild the normalized per-division membership list for the active season
 * from the live standings. Memberships are disposable between seasons and
 * always derived from the current pyramid state (plan §55).
 */
export function syncMemberships(world: World, seasonId: number): void {
  world.mpMemberships = [];
  const divs = divisionsInSeason(world, seasonId).filter((c) => c.status !== "ARCHIVED");
  for (const comp of divs) {
    const rows = standingsTiebreak(Object.values(comp.standings), eloRatings(world));
    rows.forEach((row, i) => {
      const club = clubById(world, row.clubId);
      world.mpMemberships.push({
        divisionId: comp.id,
        clubId: row.clubId,
        slotNumber: i + 1,
        isFillerAI: club !== undefined && club.ownerUserId === null && club.isHuman === false,
        replacedClubId: null,
        joinedAt: Date.now(),
      });
    });
  }
}

/**
 * Partition owned clubs into active and abandoned sets for rollover movement
 * calculation (plan §42/§45). A club is abandoned for the NEXT season if it
 * was marked abandonment-eligible during the season OR it is already DORMANT.
 * Ordinary filler AI (no owner) is never a persistent club and is handled
 * separately. PROVISIONAL clubs are queued for next season and are not part
 * of this season's pyramid yet.
 */
function partitionHumanClubs(world: World): { active: Set<number>; abandoned: Set<number> } {
  const active = new Set<number>();
  const abandoned = new Set<number>();
  for (const club of world.clubs) {
    if (club.ownerUserId === null) continue;
    if (club.competitionState === "DORMANT" || club.abandonmentEligibleAt !== null) abandoned.add(club.id);
    else if (club.competitionState === "ACTIVE") active.add(club.id);
  }
  return { active, abandoned };
}

/**
 * Divisions of the season containing at least one active human club. A
 * division without any is "extinct": at the bottom edge of the pyramid it
 * vanishes at rollover and must not receive relegations, so it does not count
 * toward the deepest populated tier. Humanless divisions ABOVE the deepest
 * populated tier are deliberately still returned by divisionsInSeason and
 * kept in the tier map: they receive relegations from above and promotions
 * from below and repopulate that way (plan §25/§26 edge cases).
 */
export function populatedDivisions(world: World, seasonId: number): Competition[] {
  const { active } = partitionHumanClubs(world);
  return divisionsInSeason(world, seasonId).filter(
    (c) => c.status !== "ARCHIVED" && Object.keys(c.standings).some((id) => active.has(Number(id))),
  );
}

/**
 * Upsert the per-club-per-season competition records (plan §55). Entries are
 * keyed by (clubId, seasonId); stale entries for the season are replaced.
 */
export function syncClubSeasons(world: World, seasonId: number): void {
  const keep = new Set<number>();
  const divs = divisionsInSeason(world, seasonId).filter((c) => c.status !== "ARCHIVED");
  const projectedAssignments = computeNextTierAssignments(world, seasonId).assignments;
  const populatedTiers = new Set(populatedDivisions(world, seasonId).map((c) => tierOf(c)));
  for (const comp of divs) {
    const rows = standingsTiebreak(Object.values(comp.standings), eloRatings(world));
    for (const row of rows) {
      const club = clubById(world, row.clubId);
       const currentTier = tierOf(comp);
       const rowsForPromotion = standingsTiebreak(Object.values(comp.standings), eloRatings(world))
         .filter((candidate) => isHumanClub(world, candidate.clubId));
       const humanRank = rowsForPromotion.findIndex((candidate) => candidate.clubId === row.clubId) + 1;
       const hasUpperTier = currentTier > 1 && divisionsInTier(world, seasonId, currentTier - 1).length > 0;
        const maxTierForSeason = Math.max(currentTier, ...populatedTiers);
       const relegationRows = currentTier < maxTierForSeason
         ? standingsTiebreak(Object.values(comp.standings), eloRatings(world)).slice(-(comp.config.relegated ?? 2))
         : [];
       const entry: MpClubSeasonEntry = {
        clubId: row.clubId,
        seasonId,
        divisionId: comp.id,
        tier: tierOf(comp),
        played: row.played,
        wins: row.wins,
        draws: row.draws,
        losses: row.losses,
        goalsFor: row.goalsFor,
        goalsAgainst: row.goalsAgainst,
        points: row.points,
          promotionStatus: hasUpperTier
            ? projectedAssignments.get(row.clubId)! < currentTier
              ? "PROMOTED"
              : humanRank > 0
                ? "POSSIBLE"
                : "NONE"
            : "NONE",
         relegationStatus: relegationRows.some((candidate) => candidate.clubId === row.clubId) ? "RELEGATED" : "NONE",
      };
      const existing = world.mpClubSeasons.find((e) => e.clubId === row.clubId && e.seasonId === seasonId);
      if (existing) Object.assign(existing, entry);
      else world.mpClubSeasons.push(entry);
      keep.add(row.clubId);
    }
  }
  world.mpClubSeasons = world.mpClubSeasons.filter((e) => e.seasonId !== seasonId || keep.has(e.clubId));
}

export function computeNextTierAssignments(world: World, seasonId: number): {
  assignments: Map<number, number>;
  activeClubIds: number[];
  abandonedClubIds: number[];
} {
  const divisions = divisionsInSeason(world, seasonId).filter((c) => c.status !== "ARCHIVED");
  const assignments = new Map<number, number>();
  const { active, abandoned } = partitionHumanClubs(world);

  // Determine target tier for every club that remains active.
  // Top-down cascade: promotions bubble up; relegations push down.
  const byTier = new Map<number, Competition[]>();
  for (const d of divisions) {
    const t = tierOf(d);
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t)!.push(d);
  }
  // The cascade is bounded by the deepest POPULATED tier: an extinct
  // bottom-edge tier (no active humans left) vanishes instead of receiving
  // relegations, making the tier above the new bottom tier. Humanless
  // divisions above that tier stay in byTier and keep their self-healing
  // flow (relegations from above + promotions from below repopulate them).
  const populatedTiers = new Set(populatedDivisions(world, seasonId).map((c) => tierOf(c)));
  const tiers = [...byTier.keys()].filter((t) => populatedTiers.has(t)).sort((a, b) => a - b);
  const maxTier = tiers.length > 0 ? Math.max(...tiers) : 1;

  // Track how many humans occupy each target tier (for compaction below).
  const tierOccupancy = new Map<number, number>();

  // Relegations: bottom `relegated` of each non-bottom division go down one.
  for (const d of divisions) {
    const t = tierOf(d);
    if (t >= maxTier) continue; // bottom tier has no relegation target
    const rows = standingsTiebreak(Object.values(d.standings), eloRatings(world));
    const relegateCount = d.config.relegated ?? 2;
    const doomed = rows.slice(-relegateCount).filter((r) => active.has(r.clubId));
    for (const r of doomed) {
      assignments.set(r.clubId, t + 1);
      tierOccupancy.set(t + 1, (tierOccupancy.get(t + 1) ?? 0) + 1);
    }
  }

  // Promotions are selected for the whole target tier. Group membership is
  // deliberately ignored here; it is rebuilt only after every target tier is
  // finalised.
  for (let t = maxTier - 1; t >= 1; t--) {
    const parents = byTier.get(t) ?? [];
    const children = byTier.get(t + 1) ?? [];
    for (const parent of parents) {
      for (const id of Object.keys(parent.standings).map(Number).filter((clubId) => active.has(clubId) && !assignments.has(clubId))) {
        assignments.set(id, t);
        tierOccupancy.set(t, (tierOccupancy.get(t) ?? 0) + 1);
      }
    }

    const targetClubIds = new Set(parents.flatMap((parent) => Object.keys(parent.standings).map(Number)));
    const incomingRelegations = [...assignments.entries()].filter(([clubId, assignedTier]) => assignedTier === t && !targetClubIds.has(clubId)).length;
    const openings = Math.max(0, parents.reduce((total, parent) => {
      const stayingMembers = Object.values(parent.standings).filter((row) => {
        const id = row.clubId;
        return !abandoned.has(id) && (assignments.get(id) ?? t) === t;
      }).length;
      return total + Math.max(0, CLUBS_PER_DIVISION - stayingMembers);
    }, 0) - incomingRelegations);
    const candidatesByChild = children.map((child) => {
      const rows = standingsTiebreak(Object.values(child.standings), eloRatings(world));
      let rank = 0;
      return rows
        .filter((row) => active.has(row.clubId) && isHumanClub(world, row.clubId) && !assignments.has(row.clubId))
        .map((row) => ({ clubId: row.clubId, humanRank: ++rank, row, eloRating: clubById(world, row.clubId)?.eloRating ?? ELO_CONFIG.initial }));
    });
    const roundOne = candidatesByChild.flat().filter((candidate) => candidate.humanRank === 1);
    if (roundOne.length > openings && openings > 0) {
      auditMultiplayerEvent(world, "PROMOTION_CAPACITY_CONSTRAINT", { metadata: JSON.stringify({ tier: t, candidates: roundOne.length, openings }) });
    }
    const selected = [...roundOne].sort(promotionCandidateTiebreak).slice(0, openings);
    if (selected.length < openings) {
      const selectedIds = new Set(selected.map((candidate) => candidate.clubId));
      const later = candidatesByChild.flat().filter((candidate) => candidate.humanRank >= 2 && !selectedIds.has(candidate.clubId));
      selected.push(...later.sort(promotionCandidateTiebreak).slice(0, openings - selected.length));
    }
    for (const candidate of selected) {
      assignments.set(candidate.clubId, t);
      tierOccupancy.set(t, (tierOccupancy.get(t) ?? 0) + 1);
    }
  }

  // Phase 8 (plan §32/§33): extra promotions from abandonment vacancies use a
  // deterministic cross-division ranking among the immediate lower tier. These
  // are additional upward moves that the per-parent loop already handles when
  // openings exceed the normal two; this block is intentionally a no-op because
  // `openings` already counts abandoned departures. Kept explicit for clarity.

  // Any remaining active humans without a tier stay at their current tier.
  for (const d of divisions) {
    const t = tierOf(d);
    for (const row of Object.values(d.standings)) {
      const id = row.clubId;
      if (active.has(id) && !assignments.has(id)) {
        assignments.set(id, t);
        tierOccupancy.set(t, (tierOccupancy.get(t) ?? 0) + 1);
      }
    }
  }

  // Phase (plan §35): pyramid compaction. If the top tier is under-populated
  // with humans and the tier below has enough humans, compaction is applied
  // ONLY within each tier's grouping at rebuild time (we never arbitrarily
  // promote a club to eliminate AI). The assignment map itself is the compact
  // representation: each tier gets every active human that belongs to it, and
  // the caller regroups by human count. Nothing further to do here.

  // Validate promotion invariants (plan §60).
  const validationErrors = validateAssignments(assignments, abandoned, active);
  if (validationErrors.length > 0) {
    throw new Error(`Promotion invariants violated: ${validationErrors.join("; ")}`);
  }

  return { assignments, activeClubIds: [...active], abandonedClubIds: [...abandoned] };
}

/**
 * Validate the promotion invariants from plan §60 before committing. Throws a
 * descriptive error so rollover fails rather than silently corrupting the
 * pyramid.
 */
function validateAssignments(assignments: Map<number, number>, abandoned: Set<number>, active: Set<number>): string[] {
  const errors: string[] = [];
  const tiersSeen = new Map<number, number>();
  for (const [clubId, tier] of assignments) {
    if (abandoned.has(clubId)) errors.push(`abandoned club ${clubId} was assigned a tier`);
    if (!active.has(clubId)) errors.push(`inactive/non-owner club ${clubId} was assigned a tier`);
    if (tiersSeen.has(clubId)) errors.push(`club ${clubId} assigned to >1 tier`);
    tiersSeen.set(clubId, tier);
  }
  for (const clubId of active) {
    if (!assignments.has(clubId)) errors.push(`active human ${clubId} missing a target tier`);
  }
  return errors;
}

/**
 * Pairwise window-overlap cost between two clubs' preferred match times
 * (plan 9): squared missing-overlap of the two UTC slot sets. A pair with any
 * unconstrained member costs 0 — same convention as kickoff scheduling, where
 * unconstrained clubs never distort the optimum.
 */
export function preferredTimeDistance(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || a.length === 0 || !b || b.length === 0) return 0;
  const setA = new Set(a);
  const shared = b.reduce((count, slot) => count + (setA.has(slot) ? 1 : 0), 0);
  return Math.pow(MP_CONFIG.slotsPerDay - shared, 2);
}

/**
 * Sum of squared pairwise missing-overlap within each proposed group.
 * `clubMap` lets hot callers (buildBalancedTierGroups) pass a pre-built
 * id->club index instead of re-scanning `world.clubs` on every lookup.
 */
export function calculatePreferredTimeCost(groups: { clubId: number }[][], world: World, clubMap?: Map<number, Club>): number {
  const lookup = (id: number) => clubMap?.get(id) ?? clubById(world, id);
  return groups.reduce((total, group) => total + group.reduce((cost, a, i) => cost + group.slice(i + 1).reduce((pairCost, b) => {
    const clubA = lookup(a.clubId);
    const clubB = lookup(b.clubId);
    return pairCost + preferredTimeDistance(clubA?.preferredHours ?? null, clubB?.preferredHours ?? null);
  }, 0), 0), 0);
}

/**
 * Circular centroid slot of a club's preferred windows (circular mean over the
 * slot ring). Used only to seed the rotation order so clubs with nearby windows
 * start contiguous; wrapped windows (nights around midnight) resolve correctly.
 * Returns null for unconstrained clubs, which sort last.
 */
export function preferredCentroid(preferredSlots: number[] | null | undefined): number | null {
  if (!preferredSlots || preferredSlots.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const slot of preferredSlots) {
    const angle = (slot / MP_CONFIG.slotsPerDay) * 2 * Math.PI;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  const normalized = ((Math.atan2(y, x) / (2 * Math.PI)) * MP_CONFIG.slotsPerDay + MP_CONFIG.slotsPerDay) % MP_CONFIG.slotsPerDay;
  return normalized;
}

/** `clubMap` lets hot callers pass a pre-built id->club index (see above). */
export function calculateEloBalanceCost(groups: { clubId: number }[][], world: World, clubMap?: Map<number, Club>): number {
  const lookup = (id: number) => clubMap?.get(id) ?? clubById(world, id);
  const humans = groups.flat();
  if (humans.length === 0) return 0;
  const mean = humans.reduce((sum, human) => sum + (lookup(human.clubId)?.eloRating ?? ELO_CONFIG.initial), 0) / humans.length;
  return groups.reduce((total, group) => {
    if (group.length === 0) return total;
    const groupMean = group.reduce((sum, human) => sum + (lookup(human.clubId)?.eloRating ?? ELO_CONFIG.initial), 0) / group.length;
    return total + group.length * Math.pow(groupMean - mean, 2);
  }, 0);
}

/** Canonical membership key for an unordered club pair. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Consented friendship graph over human clubs: bilateral opt-in gates every
 * edge (plan 9). Shared by scoring AND the regrouping optimizers so the
 * bilateral-consent rule lives in exactly one place.
 */
function buildSocialGraph(world: World): { direct: Set<string>; neighbors: Map<number, Set<number>> } {
  const clubsByUser = new Map(world.clubs.filter((club) => club.ownerUserId !== null).map((club) => [club.ownerUserId!, club.id]));
  const optedIn = new Set<number>();
  for (const club of world.clubs) {
    if (club.ownerUserId !== null && club.friendGroupingOptIn !== false) optedIn.add(club.id);
  }
  const direct = new Set<string>();
  const neighbors = new Map<number, Set<number>>();
  for (const friendship of world.friendships ?? []) {
    if (friendship.userAId === friendship.userBId) continue;
    const a = clubsByUser.get(friendship.userAId);
    const b = clubsByUser.get(friendship.userBId);
    if (a === undefined || b === undefined || a === b) continue;
    if (!optedIn.has(a) || !optedIn.has(b)) continue;
    direct.add(pairKey(a, b));
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  }
  return { direct, neighbors };
}

/**
 * Return the lexicographic social score for a proposed grouping. Direct
 * friendships always outrank friends-of-friends. Missing friendship data is
 * intentionally treated as an empty graph for legacy worlds.
 *
 * Bilateral consent (plan 9): an edge influences grouping only when BOTH
 * owners kept friend-grouping enabled (`friendGroupingOptIn !== false`), so a
 * player can never be pulled into someone else's group against their will.
 */
export function calculateSocialScore(
  groups: { clubId: number }[][],
  world: World,
  graph?: { direct: Set<string>; neighbors: Map<number, Set<number>> },
): { direct: number; friendsOfFriends: number } {
  const { direct, neighbors } = graph ?? buildSocialGraph(world);
  let directScore = 0;
  let friendsOfFriendsScore = 0;
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i].clubId;
        const b = group[j].clubId;
        if (direct.has(pairKey(a, b))) {
          directScore++;
          continue;
        }
        const aNeighbors = neighbors.get(a);
        const bNeighbors = neighbors.get(b);
        if (aNeighbors && bNeighbors && [...aNeighbors].some((neighbor) => bNeighbors.has(neighbor))) friendsOfFriendsScore++;
      }
    }
  }
  return { direct: directScore, friendsOfFriends: friendsOfFriendsScore };
}

/**
 * Rebuild divisions for a tier from a set of humans, maximizing human density
 * first and then minimizing preferred-match-time spread (plan §36, as amended
 * by plan 9: window-overlap clustering instead of timezone clustering). Only
 * the final incomplete bottom division receives filler AI.
 */
export function rebuildTierDivisions(
  world: World,
  seasonId: number,
  tier: number,
  humans: { clubId: number }[],
  ref: { year: number; month: number },
  options: { generateFixtures?: boolean; assignmentSeed?: number } = {},
): Competition[] {
  // Remove existing divisions at this tier.
  const old = divisionsInTier(world, seasonId, tier);
  for (const c of old) {
    world.competitions = world.competitions.filter((x) => x.id !== c.id);
    world.fixtures = world.fixtures.filter((f) => f.competitionId !== c.id);
  }

  const required = humans.length === 0 ? 0 : Math.ceil(humans.length / CLUBS_PER_DIVISION);
  if (required === 0) return [];
  if (required > MAX_DIVISIONS_PER_TIER(tier)) throw new Error(`Tier ${tier} cannot contain ${humans.length} human clubs`);
  const groups = buildBalancedTierGroups(world, humans, required, options.assignmentSeed);

  const created: Competition[] = [];
  for (let g = 0; g < groups.length; g++) {
    const div = createDivision(world, { tier, groupIndex: g, seasonId, ref });
    for (const h of groups[g]) {
      div.standings[h.clubId] = emptyStandingsRow(h.clubId);
      clubById(world, h.clubId)!.competitionState = "ACTIVE";
    }
    // Filler is inserted only after all humans have been assigned.
    ensureDivisionFull(world, div);
    if (options.generateFixtures !== false) {
      const fixtures = generateDivisionFixtures(world, div, ref);
      world.fixtures.push(...fixtures);
    }
    div.status = "ACTIVE";
    created.push(div);
  }
  return created;
}

function buildBalancedTierGroups(
  world: World,
  humans: { clubId: number }[],
  required: number,
  assignmentSeed?: number,
): { clubId: number }[][] {
  // Both the id->club index and the friendship graph are invariant for the
  // whole call: build them once here and thread them through instead of
  // having every nested scoring/search helper below re-derive them.
  const clubMap = new Map(world.clubs.map((c) => [c.id, c]));
  const graph = buildSocialGraph(world);
  const baseSize = Math.floor(humans.length / required);
  const extra = humans.length % required;
  const capacities = Array.from({ length: required }, (_, i) => baseSize + (i < extra ? 1 : 0));
  const sorted = [...humans].sort((a, b) => {
    // Seed rotations from the circular centroid of each club's preferred
    // windows so every candidate starts window-contiguous; unconstrained
    // clubs (null preferences) sort last and only contribute tie-breaks.
    const centroidA = preferredCentroid(clubMap.get(a.clubId)?.preferredHours ?? null);
    const centroidB = preferredCentroid(clubMap.get(b.clubId)?.preferredHours ?? null);
    if (centroidA === null || centroidB === null) {
      if (centroidA !== null) return -1;
      if (centroidB !== null) return 1;
    } else if (Math.abs(centroidA - centroidB) > 1e-9) {
      return centroidA - centroidB;
    }
    const tieA = assignmentSeed === undefined ? a.clubId : seededTieBreak(assignmentSeed, a.clubId);
    const tieB = assignmentSeed === undefined ? b.clubId : seededTieBreak(assignmentSeed, b.clubId);
    return tieA - tieB || a.clubId - b.clubId;
  });
  // Objectives 2–3 (plan 9 §2): solve the friendship packing EXACTLY when the
  // search fits its node budget; only oversized tiers fall back to the
  // rotation heuristic below. Either way, availability is then descended at
  // fixed social score before Elo gets its guarded improvement pass.
  const exactGroups = bestExactSocialGroups(humans, capacities, sorted, graph);
  let best: GroupCandidate | null = null;
  if (exactGroups) {
    improveAvailabilityAtFixedSocial(exactGroups, world, clubMap, graph);
    best = measureGroups(exactGroups, world, 0, clubMap, graph);
  } else {
    for (let rotation = 0; rotation < sorted.length; rotation++) {
      const rotated = sorted.map((_, i) => sorted[(i + rotation) % sorted.length]);
      const groups: { clubId: number }[][] = [];
      let cursor = 0;
      for (const capacity of capacities) {
        groups.push(rotated.slice(cursor, cursor + capacity));
        cursor += capacity;
      }
      improveAssignment(groups, world, clubMap, graph);
      const candidate = measureGroups(groups, world, assignmentSeed === undefined ? rotation : seededTieBreak(assignmentSeed, rotation), clubMap, graph);
      if (!best || lexBetter(candidate, best)) best = candidate;
    }
  }
  if (!best) return [];

  // Only swaps preserving both higher-priority objectives may improve Elo.
  let improved = true;
  while (improved) {
    improved = false;
    const currentElo = calculateEloBalanceCost(best.groups, world, clubMap);
    for (let leftIndex = 0; leftIndex < best.groups.length && !improved; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < best.groups.length && !improved; rightIndex++) {
        for (let leftMember = 0; leftMember < best.groups[leftIndex].length && !improved; leftMember++) {
          for (let rightMember = 0; rightMember < best.groups[rightIndex].length; rightMember++) {
            const candidate = best.groups.map((group) => [...group]);
            [candidate[leftIndex][leftMember], candidate[rightIndex][rightMember]] = [candidate[rightIndex][rightMember], candidate[leftIndex][leftMember]];
            if (calculatePreferredTimeCost(candidate, world, clubMap) !== best.avail) continue;
            const social = calculateSocialScore(candidate, world, graph);
            if (social.direct !== best.social.direct || social.friendsOfFriends !== best.social.friendsOfFriends) continue;
            const candidateElo = calculateEloBalanceCost(candidate, world, clubMap);
            if (candidateElo < currentElo - ELO_CONFIG.costEpsilon) {
              best.groups = candidate;
              best.social = social;
              best.elo = candidateElo;
              improved = true;
              break;
            }
          }
        }
      }
    }
  }
  return best.groups;
}

/** Stable pseudo-random ordering for persisted group-assignment tie-breaks. */
function seededTieBreak(seed: number, value: number): number {
  let x = (seed ^ Math.imul(value, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** One evaluated grouping candidate, compared lexicographically (plan 9 §2). */
interface GroupCandidate {
  groups: { clubId: number }[][];
  social: { direct: number; friendsOfFriends: number };
  avail: number;
  elo: number;
  tieRank: number;
}

function measureGroups(
  groups: { clubId: number }[][],
  world: World,
  tieRank: number,
  clubMap: Map<number, Club>,
  graph: { direct: Set<string>; neighbors: Map<number, Set<number>> },
): GroupCandidate {
  return {
    groups,
    social: calculateSocialScore(groups, world, graph),
    avail: calculatePreferredTimeCost(groups, world, clubMap),
    elo: calculateEloBalanceCost(groups, world, clubMap),
    tieRank,
  };
}

/** Lexicographic preference: direct friends → friends-of-friends → overlap → Elo → seeded rank. */
function lexBetter(a: GroupCandidate, b: GroupCandidate): boolean {
  if (a.social.direct !== b.social.direct) return a.social.direct > b.social.direct;
  if (a.social.friendsOfFriends !== b.social.friendsOfFriends) return a.social.friendsOfFriends > b.social.friendsOfFriends;
  if (a.avail !== b.avail) return a.avail < b.avail;
  if (Math.abs(a.elo - b.elo) > ELO_CONFIG.costEpsilon) return a.elo < b.elo;
  return a.tieRank < b.tieRank;
}

class SearchBudgetExceeded extends Error {}

/**
 * Deterministic branch-and-bound over every capacity-respecting assignment,
 * maximizing the packed social key `direct * (totalPairs + 1) + fof` exactly
 * (plan 9 §2 objectives 2–3). A node budget keeps worst-case tiers bounded —
 * when it is exhausted the caller falls back to the rotation heuristic below.
 * Empty groups of equal capacity are interchangeable, so only the first is
 * explored (symmetry break); this preserves completeness.
 */
function bestExactSocialGroups(
  humans: { clubId: number }[],
  capacities: number[],
  order: { clubId: number }[],
  graph: { direct: Set<string>; neighbors: Map<number, Set<number>> },
  nodeBudget = 250_000,
): { clubId: number }[][] | null {
  const required = capacities.length;
  const totalPairs = capacities.reduce((sum, size) => sum + (size * (size - 1)) / 2, 0);
  const weight = totalPairs + 1;
  const maxCapacity = Math.max(...capacities);
  let nodes = 0;
  let bestKey = -1;
  let best: { clubId: number }[][] | null = null;
  const groups: { clubId: number }[][] = Array.from({ length: required }, () => []);
  try {
    const recurse = (index: number, directSoFar: number, fofSoFar: number): void => {
      if (++nodes > nodeBudget) throw new SearchBudgetExceeded();
      const remaining = order.length - index;
      if (remaining === 0) {
        const key = directSoFar * weight + fofSoFar;
        if (key > bestKey) {
          bestKey = key;
          best = groups.map((group) => [...group]);
        }
        return;
      }
      // Upper bound on any completion: each remaining member adds at most one
      // pair per co-member; max capacity bounds that tightly enough to prune.
      const slack = remaining * (maxCapacity - 1);
      if (bestKey >= 0 && (directSoFar + slack) * weight + fofSoFar + slack <= bestKey) return;
      const entry = order[index];
      for (let g = 0; g < required; g++) {
        if (groups[g].length >= capacities[g]) continue;
        if (groups[g].length === 0) {
          let duplicateEmpty = false;
          for (let h = 0; h < g; h++) {
            if (groups[h].length === 0 && capacities[h] === capacities[g]) {
              duplicateEmpty = true;
              break;
            }
          }
          if (duplicateEmpty) continue;
        }
        let d = 0;
        let f = 0;
        for (const member of groups[g]) {
          if (graph.direct.has(pairKey(entry.clubId, member.clubId))) d++;
          else {
            const mine = graph.neighbors.get(entry.clubId);
            const theirs = graph.neighbors.get(member.clubId);
            if (mine && theirs && [...mine].some((mid) => theirs.has(mid))) f++;
          }
        }
        groups[g].push(entry);
        recurse(index + 1, directSoFar + d, fofSoFar + f);
        groups[g].pop();
      }
    };
    recurse(0, 0, 0);
  } catch (error) {
    if (!(error instanceof SearchBudgetExceeded)) throw error;
    return null;
  }
  return best;
}

/**
 * Hill-climb one candidate toward the lexicographic optimum (direct friends →
 * friends-of-friends → window overlap) with single member swaps. Used by the
 * heuristic fallback for worlds too large for the exact search; a swap is only
 * adopted when it improves a higher objective or keeps them identical while
 * strictly reducing availability cost.
 */
function improveAssignment(
  groups: { clubId: number }[][],
  world: World,
  clubMap: Map<number, Club>,
  graph: { direct: Set<string>; neighbors: Map<number, Set<number>> },
): void {
  let improved = true;
  while (improved) {
    improved = false;
    const current = calculateSocialScore(groups, world, graph);
    const currentAvail = calculatePreferredTimeCost(groups, world, clubMap);
    for (let leftIndex = 0; leftIndex < groups.length && !improved; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < groups.length && !improved; rightIndex++) {
        for (let leftMember = 0; leftMember < groups[leftIndex].length && !improved; leftMember++) {
          for (let rightMember = 0; rightMember < groups[rightIndex].length; rightMember++) {
            const candidate = groups.map((group) => [...group]);
            [candidate[leftIndex][leftMember], candidate[rightIndex][rightMember]] = [candidate[rightIndex][rightMember], candidate[leftIndex][leftMember]];
            const score = calculateSocialScore(candidate, world, graph);
            const socialGain = score.direct > current.direct ||
              (score.direct === current.direct && score.friendsOfFriends > current.friendsOfFriends);
            const socialNeutral = score.direct === current.direct && score.friendsOfFriends === current.friendsOfFriends;
            if (socialGain || (socialNeutral && calculatePreferredTimeCost(candidate, world, clubMap) < currentAvail)) {
              groups[leftIndex] = candidate[leftIndex];
              groups[rightIndex] = candidate[rightIndex];
              improved = true;
              break;
            }
          }
        }
      }
    }
  }
}

/**
 * Swap members between groups while both social objectives stay EXACTLY
 * identical, strictly reducing window-overlap cost. Higher-priority objectives
 * are never traded away (plan 9 §2: overlap sits below both social scores).
 */
function improveAvailabilityAtFixedSocial(
  groups: { clubId: number }[][],
  world: World,
  clubMap: Map<number, Club>,
  graph: { direct: Set<string>; neighbors: Map<number, Set<number>> },
): void {
  const base = calculateSocialScore(groups, world, graph);
  let improved = true;
  while (improved) {
    improved = false;
    const currentAvail = calculatePreferredTimeCost(groups, world, clubMap);
    for (let leftIndex = 0; leftIndex < groups.length && !improved; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < groups.length && !improved; rightIndex++) {
        for (let leftMember = 0; leftMember < groups[leftIndex].length && !improved; leftMember++) {
          for (let rightMember = 0; rightMember < groups[rightIndex].length; rightMember++) {
            const candidate = groups.map((group) => [...group]);
            [candidate[leftIndex][leftMember], candidate[rightIndex][rightMember]] = [candidate[rightIndex][rightMember], candidate[leftIndex][leftMember]];
            const score = calculateSocialScore(candidate, world, graph);
            if (score.direct !== base.direct || score.friendsOfFriends !== base.friendsOfFriends) continue;
            if (calculatePreferredTimeCost(candidate, world, clubMap) < currentAvail) {
              groups[leftIndex] = candidate[leftIndex];
              groups[rightIndex] = candidate[rightIndex];
              improved = true;
              break;
            }
          }
        }
      }
    }
  }
}

/** Reset a division's standings for a new season. */
export function resetDivisionStandings(world: World, comp: Competition) {
  for (const key of Object.keys(comp.standings)) {
    comp.standings[Number(key)] = emptyStandingsRow(Number(key));
  }
}

/**
 * Play a non-persistent practice/friendly match (plan §15). Provisional clubs
 * use this to stay engaged. It generates NO league points, NO permanent player
 * development/XP, NO prize money, NO injuries and NO disciplinary consequences:
 * the match is simulated in memory and only the scoreline is returned.
 */
export function playPracticeMatch(world: World, clubId: number): { homeGoals: number; awayGoals: number; events: number; opponentName: string } | null {
  const club = clubById(world, clubId);
  if (!club || club.competitionState !== "PROVISIONAL") return null;
  const opponents = world.clubs.filter((c) => c.id !== clubId && c.ownerUserId === null && c.competitionState === "ACTIVE");
  if (opponents.length === 0) return null;
  const rng = { ...world.rng };
  const opponent = opponents[nextInt(rng, opponents.length)];
  // The match engine mutates player objects while it simulates fatigue,
  // injuries and goals. Practice is explicitly non-persistent, so run it on
  // isolated copies and only keep the random stream/activity record.
  const copyPlayer = (player: Player): Player => ({
    ...player,
    skills: { ...player.skills },
    skillAcc: [...player.skillAcc],
    recentMinutes: [...player.recentMinutes],
    careerProfile: { ...player.careerProfile },
  });
  const practicePlayers = world.players.map(copyPlayer);
  const copyClub = (source: Club): Club => ({
    ...source,
    tactics: { ...source.tactics },
    ledger: { income: [], expense: [] },
    trophies: { ...source.trophies },
    savedLineup: undefined,
  });
  const sim = simulateMatch(rng, copyClub(club), copyClub(opponent), practicePlayers, {
    competitionId: -1,
    fixtureId: -1,
    homeNeutral: false,
    decider: false,
    compKind: "division",
    year: world.mp.seasonYear,
  });
  // Deliberately NOT applying applyMatchToPlayers: practice results are
  // non-persistent and must not farm progression (plan §15).
  return { homeGoals: sim.homeGoals, awayGoals: sim.awayGoals, events: sim.match.events.length, opponentName: opponent.name };
}

export { overallFromSkills };
