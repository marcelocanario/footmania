import type {
  Club,
  Competition,
  Fixture,
  Match,
  Player,
  World,
} from "./types";
import { pick } from "./rng";
import { createLiveMatchState, simulateMatch, applyMatchToPlayers, buildMatchFromState, tickLiveMatch } from "./match";
import { updateStandings, isLeagueFinished } from "./league";
import { aiBid, auctionAvailableCash, isEligibleAuctionBidder, resolveAuction } from "./transfers";
import { calcGate } from "./club";
import { MP_CONFIG } from "../config";
import { completedRounds, seasonRefFor, seasonStatusFor } from "./clock";
import { auditMultiplayerEvent, syncClubSeasons } from "./multiplayer";
import { missingDailyDates, processDailyDate, utcDateKey } from "./daily";

export function nextId(world: World): number {
  return world.nextId++;
}

export function findClub(world: World, id: number): Club | undefined {
  return world.clubs.find((c) => c.id === id);
}

export function findCompetition(world: World, id: number): Competition | undefined {
  return world.competitions.find((c) => c.id === id);
}

export function fixturesForDay(world: World, dayIndex: number): Fixture[] {
  return world.fixtures.filter((f) => f.dayIndex === dayIndex && !f.played);
}

// ---------------------------------------------------------------------------
// Multiplayer worker core (server-authoritative)
// ---------------------------------------------------------------------------

/** Create a live match state for a scheduled fixture. Every league match fires
 *  live at its kickoff, whether or not a human is watching; humans present can
 *  intervene via the WebSocket (subs, formation). */
export function startLiveMatch(world: World, fixture: Fixture): Match | null {
  const home = findClub(world, fixture.homeClubId);
  const away = findClub(world, fixture.awayClubId);
  if (!home || !away) return null;
  const comp = findCompetition(world, fixture.competitionId);
  const match: Match = {
    id: world.nextId++,
    fixtureId: fixture.id,
    competitionId: fixture.competitionId,
    homeClubId: fixture.homeClubId,
    awayClubId: fixture.awayClubId,
    homeScore: 0,
    awayScore: 0,
    penaltyWinnerId: null,
    attendance: 0,
    gateRevenue: 0,
    events: [],
    stats: { possession: [50, 50], shots: [0, 0], onGoal: [0, 0], offTarget: [0, 0], fouls: [0, 0], corners: [0, 0], yellows: [0, 0], reds: [0, 0], tackles: [0, 0], wrongPasses: [0, 0] },
    minuteEvents: [],
  };
  world.matches.push(match);
  const st = createLiveMatchState(world.rng, home, away, world.players, {
    matchId: match.id,
    competitionId: fixture.competitionId,
    fixtureId: fixture.id,
    homeNeutral: false,
    decider: false,
    compKind: comp?.kind ?? "division",
    year: world.mp.seasonYear,
  });
  world.liveMatches.push(st);
  // A restarted worker must account for time spent offline. The fixture's
  // scheduled kickoff, rather than process start time, is the pacing origin.
  st.lastAdvancedAt = fixture.kickoffAt ?? Date.now();
  for (const clubId of [home.id, away.id]) {
    const club = findClub(world, clubId);
    if (club) club.liveMatchAt = fixture.kickoffAt ?? Date.now();
  }
  return match;
}

/**
 * Advance in-progress live matches based on real elapsed time (plan §37/§54).
 *
 * The configured `matchDurationMinutes` is the real-world wall-clock time a
 * full match (90 match minutes) takes to play out. Each call computes how many
 * match minutes are due since the match's `lastAdvancedAt`, carrying the
 * fractional remainder so cumulative pacing stays exact regardless of tick
 * rate or downtime. Auto-plays through halftime (`resume: true`) so matches
 * finish on schedule for unattended clubs.
 */
export function advanceLiveMatches(world: World, now: number): Match[] {
  const finished: Match[] = [];
  const realMsPerMatchMinute = (MP_CONFIG.matchDurationMinutes * 60 * 1000) / 90;
  for (const st of [...world.liveMatches]) {
    if (st.ended) {
      const m = finalizeLiveMatch(world, st);
      if (m) finished.push(m);
      continue;
    }
    const home = findClub(world, st.homeClubId);
    const away = findClub(world, st.awayClubId);
    if (!home || !away) continue;
    const last = st.lastAdvancedAt ?? now;
    const elapsedMs = Math.max(0, now - last);
    const wholeMinutes = Math.floor(elapsedMs / realMsPerMatchMinute);
    if (wholeMinutes <= 0) continue;

    const played = st.minute + (st.half === 1 ? st.firstHalfLen : 0);
    const remaining = (st.firstHalfLen + st.secondHalfLen) - played;
    const minutes = Math.min(wholeMinutes, Math.max(1, remaining));
    tickLiveMatch(world.rng, home, away, world.players, st, minutes, { ignoreHalfTime: true });
    // The match is now fully simulated up to the real time that `minutes`
    // match-minutes represent. Any sub-minute fraction of the elapsed window
    // is preserved for the next tick (lastAdvancedAt only moves forward by the
    // real time consumed, so a 5s worker still finishes in ~matchDuration).
    st.lastAdvancedAt = last + minutes * realMsPerMatchMinute;
    if (st.ended) {
      const m = finalizeLiveMatch(world, st);
      if (m) finished.push(m);
    }
  }
  return finished;
}

/** Finalize a finished live match: apply gate, standings, player effects. */
export function finalizeLiveMatch(world: World, st: { matchId: number; fixtureId: number; homeClubId: number; awayClubId: number; suspensionClears?: number[] }): Match | null {
  const rng = world.rng;
  const home = findClub(world, st.homeClubId);
  const away = findClub(world, st.awayClubId);
  const fixture = world.fixtures.find((f) => f.id === st.fixtureId);
  if (!home || !away) return null;
  const live = world.liveMatches.find((x) => x.matchId === st.matchId);
  const match = live ? buildMatchFromState(live, home, away, world.players) : null;
  if (!match) return null;
  const comp = fixture ? findCompetition(world, fixture.competitionId) : undefined;
  const gate = calcGate(rng, home, away, comp?.kind ?? "division", world.ticketPrices[home.id]);
  match.attendance = gate.attendance;
  match.gateRevenue = gate.revenue;
  home.cash += gate.revenue;
  home.ledger.income.push({ code: 1, amount: gate.revenue, day: world.dayIndex, label: `Gate receipts (${comp?.name ?? ""})` });

  const existing = world.matches.find((m) => m.id === st.matchId);
  if (existing) Object.assign(existing, match, { id: st.matchId });
  else world.matches.push(match);
  if (fixture) fixture.played = true;
  applyMatchToPlayers(match, world);
  for (const id of st.suspensionClears ?? []) {
    const p = world.players.find((x) => x.id === id);
    if (p) p.suspendedGames = Math.max(0, p.suspendedGames - 1);
  }
  if (fixture && comp && comp.kind === "division") {
    updateStandings(comp, fixture.homeClubId, fixture.awayClubId, match.homeScore, match.awayScore);
    if (comp.seasonId !== undefined) syncClubSeasons(world, comp.seasonId);
  }
  updateConfidence(world, match);
  // Remove the finished live state.
  world.liveMatches = world.liveMatches.filter((x) => x.matchId !== st.matchId);
  for (const club of [home, away]) club.liveMatchAt = null;
  return match;
}

/** Play a fixture instantly (no live watch) — used for division history sim. */
export function playFixtureInstant(world: World, fixture: Fixture): Match | null {
  const home = findClub(world, fixture.homeClubId);
  const away = findClub(world, fixture.awayClubId);
  if (!home || !away) return null;
  const comp = findCompetition(world, fixture.competitionId);
  const match: Match = {
    id: world.nextId++,
    fixtureId: fixture.id,
    competitionId: fixture.competitionId,
    homeClubId: fixture.homeClubId,
    awayClubId: fixture.awayClubId,
    homeScore: 0,
    awayScore: 0,
    penaltyWinnerId: null,
    attendance: 0,
    gateRevenue: 0,
    events: [],
    stats: { possession: [50, 50], shots: [0, 0], onGoal: [0, 0], offTarget: [0, 0], fouls: [0, 0], corners: [0, 0], yellows: [0, 0], reds: [0, 0], tackles: [0, 0], wrongPasses: [0, 0] },
    minuteEvents: [],
  };
  const sim = simulateMatch(world.rng, home, away, world.players, {
    competitionId: fixture.competitionId,
    fixtureId: fixture.id,
    homeNeutral: false,
    decider: false,
    compKind: comp?.kind ?? "division",
    year: world.mp.seasonYear,
  });
  match.homeScore = sim.homeGoals;
  match.awayScore = sim.awayGoals;
  match.events = sim.match.events;
  match.stats = sim.match.stats;
  match.penaltyWinnerId = sim.match.penaltyWinnerId;
  match.penaltyScore = sim.match.penaltyScore;
  match.extraTime = sim.match.extraTime;
  match.minuteEvents = sim.match.minuteEvents;
  match.minutes = sim.match.minutes;
  const gate = calcGate(world.rng, home, away, comp?.kind ?? "division", world.ticketPrices[home.id]);
  match.attendance = gate.attendance;
  match.gateRevenue = gate.revenue;
  home.cash += gate.revenue;
  home.ledger.income.push({ code: 1, amount: gate.revenue, day: world.dayIndex, label: `Gate receipts (${comp?.name ?? ""})` });
  fixture.played = true;
  world.matches.push(match);
  applyMatchToPlayers(match, world);
  for (const id of sim.suspensionClears) {
    const player = world.players.find((candidate) => candidate.id === id);
    if (player) player.suspendedGames = Math.max(0, player.suspendedGames - 1);
  }
  if (comp && comp.kind === "division") {
    updateStandings(comp, fixture.homeClubId, fixture.awayClubId, match.homeScore, match.awayScore);
    if (comp.seasonId !== undefined) syncClubSeasons(world, comp.seasonId);
  }
  updateConfidence(world, match);
  return match;
}

/** Kick off every due fixture (kickoff <= now, not played, not already live). */
export function processDueFixtures(world: World, now: number): Match[] {
  const started: Match[] = [];
  const liveFixtureIds = new Set(world.liveMatches.map((s) => s.fixtureId));
  for (const f of world.fixtures) {
    if (f.played) continue;
    if (f.kickoffAt !== undefined && f.kickoffAt > now) continue;
    if (liveFixtureIds.has(f.id)) continue;
    const m = startLiveMatch(world, f);
    if (m) started.push(m);
  }
  return started;
}

/** Update world.mp.completedRounds from the real clock. */
export function syncCompletedRounds(world: World, now: number): void {
  const ref = seasonRefFor(new Date(now));
  // Manual advancement is forward-only. Clearing manual mode must not rewind
  // standings or reopen joining after those rounds were already simulated.
  world.mp.completedRounds = Math.max(world.mp.completedRounds, completedRounds(ref, now, world.mp.matchKickoffHour));
  world.mp.seasonStatus = seasonStatusFor(ref, now, world.mp.matchKickoffHour);
  const lockRound = world.mp.joinLockRound;
  if (world.mp.completedRounds >= lockRound && world.mp.joinState !== "LOCKED") {
    world.mp.joinState = "LOCKED";
    auditMultiplayerEvent(world, "JOIN_LOCK_ACTIVATED", { metadata: JSON.stringify({ completedRounds: world.mp.completedRounds, joinLockRound: lockRound }) });
  }
}

/** Daily tick: energy, development, payroll, weekly sim, auctions, AI activity.
 *  Delegates to the date-aware processor in ./daily (worker plan §3). The
 *  worker drives catch-up through `missingDailyDates` + `processDailyDate`
 *  directly so it can persist after every missed date; this shim advances the
 *  current date only and is retained for callers that tick the live world. */
export function runDailyTick(world: World, now: number) {
  const todayKey = utcDateKey(new Date(now));
  if (world.mp.lastDailyTickDate === todayKey) return;
  const dates = missingDailyDates(world.mp.lastDailyTickDate, new Date(now));
  for (const date of dates) {
    const day = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
    const ref = seasonRefFor(day);
    // Only process dates inside the world's current season month; month-boundary
    // transitions are owned by the season scheduler / daily processor.
    if (ref.year !== world.mp.seasonYear || ref.month !== world.mp.seasonMonth) continue;
    processDailyDate(world, { date, now: day.getTime() });
    world.mp.lastDailyTickDate = date;
  }
}

/** Minute-resolution auction settlement (plan §51). */
export function settleDueAuctions(world: World, now: number) {
  // The persistent Auction.endsAt column is indexed.  The in-memory world is
  // already loaded for the worker, so first narrow the work to due listings;
  // never run bidder/settlement logic for every open auction on every tick.
  const dueListings = world.auctions.filter((listing) => {
    const deadline = listing.endsAt ?? Date.UTC(seasonRefFor(new Date(now)).year, seasonRefFor(new Date(now)).month - 1, Math.max(1, Math.min(31, listing.deadlineDay)), MP_CONFIG.matchKickoffHourUtc, 0, 0);
    return now >= deadline;
  }).sort((a, b) => (a.endsAt ?? 0) - (b.endsAt ?? 0));
  for (const listing of [...dueListings]) {
    // Resolve using the absolute endsAt timestamp when present (plan §51);
    // legacy rows fall back to the day-of-month cutoff hour.
    let deadline = listing.endsAt;
    if (deadline === undefined) {
      const ref = seasonRefFor(new Date(now));
      deadline = Date.UTC(ref.year, ref.month - 1, Math.max(1, Math.min(31, listing.deadlineDay)), MP_CONFIG.matchKickoffHourUtc, 0, 0);
    }
    if (now >= deadline) {
      for (const club of world.clubs) {
        if (!isEligibleAuctionBidder(listing, club)) continue;
        const player = world.players.find((p) => p.id === listing.playerId);
        if (!player) continue;
        const bid = aiBid(world.rng, club, listing, player.value, player.position, world.players, auctionAvailableCash(world, club.id, listing.id));
        if (bid !== null) listing.bids.push({ clubId: club.id, amount: bid });
      }
      const winner = resolveAuction(world, listing.id);
      auditMultiplayerEvent(world, "AUCTION_SETTLEMENT", { clubId: winner, metadata: JSON.stringify({ auctionId: listing.id, winner }) });
      if (winner !== null) {
        const club = findClub(world, winner);
        const player = world.players.find((p) => p.id === listing.playerId);
        world.news.push({ dayIndex: world.dayIndex, text: `${club?.name ?? "Club"} won the auction for ${player?.name ?? "a player"}`, kind: "auction" });
      }
    }
  }
}

export function aiBidDuringWindow(world: World, now = Date.now()) {
  const open = world.auctions.filter((a) => (a.endsAt !== undefined ? a.endsAt > now : a.deadlineDay > world.dayIndex));
  if (open.length === 0) return;
  const listing = pick(world.rng, open);
  const player = world.players.find((p) => p.id === listing.playerId);
  if (!player) return;
  const candidates = world.clubs.filter((c) => isEligibleAuctionBidder(listing, c));
  if (candidates.length === 0) return;
  const club = pick(world.rng, candidates);
  const bid = aiBid(world.rng, club, listing, player.value, player.position, world.players, auctionAvailableCash(world, club.id, listing.id));
  if (bid !== null) listing.bids.push({ clubId: club.id, amount: bid });
}

export function allDivisionsFinished(world: World): boolean {
  const divs = world.competitions.filter((c) => c.kind === "division" && c.status !== "ARCHIVED");
  if (divs.length === 0) return false;
  return divs.every((c) => isLeagueFinished(c, world.fixtures) && Object.values(c.standings).length > 0);
}

function applyMatchToStandings(world: World, fixture: Fixture, match: Match) {
  const comp = findCompetition(world, fixture.competitionId);
  if (!comp) return;
  if (comp.kind === "division") updateStandings(comp, fixture.homeClubId, fixture.awayClubId, match.homeScore, match.awayScore);
}

function updateConfidence(world: World, match: Match) {
  const home = findClub(world, match.homeClubId);
  const away = findClub(world, match.awayClubId);
  if (!home || !away) return;
  const hGoals = match.homeScore;
  const aGoals = match.awayScore;
  const apply = (club: Club, opponent: Club, goals: number, conceded: number) => {
    let board = 0;
    if (goals > conceded) board = club.level <= opponent.level ? 5 : 3;
    else if (goals < conceded) board = club.level >= opponent.level ? -7 : -4;
    club.boardConfidence = Math.max(0, Math.min(100, club.boardConfidence + board));
    let fan = board > 0 ? 3 : board < 0 ? -4 : 0;
    fan += Math.min(3, goals);
    if (home.country === away.country) fan += goals > conceded ? 2 : goals === conceded ? 1 : -1;
    club.fanConfidence = Math.max(0, Math.min(100, club.fanConfidence + fan));
  };
  apply(home, away, hGoals, aGoals);
  apply(away, home, aGoals, hGoals);
}

export function roundLabelFor(competition: Competition, round: number): string {
  return `Round ${round + 1}`;
}
