import type { Club, LiveMatchState, Match, MatchEvent, MatchStats, Player, RngState, World } from "./types";
import { nextInt } from "./rng";
import { lineupForMatch } from "./club";
import { DEVELOPMENT, EVENT_CODES } from "./constants";
import {
  advancePossessionMatch,
  computeAttributeCenters,
  engineDirection,
  enginePressing,
  engineStyle,
  simulatePossessionMatch,
  type AttributeCenters,
} from "./matchSim";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";

// ---------------------------------------------------------------------------
// Public match-engine facade (plans/6. match-simulator-overhaul.md).
//
// The possession-state engine lives in ./matchSim; this module keeps the
// historical public API (createLiveMatchState / tickLiveMatch / simulateMatch /
// performLiveSub / buildMatchFromState / livePhase / rebuildLiveHumanLineup /
// rating helpers / applyMatchToPlayers) so callers (world, routes, ws, tests)
// are unaffected. All behavioral logic is delegated to the config-driven
// engine.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

export interface MatchSetup {
  home: Club;
  away: Club;
  homeXI: Player[];
  awayXI: Player[];
  homeSubs: Player[];
  awaySubs: Player[];
  positions: number[];
}

export function setupMatch(home: Club, away: Club, allPlayers: Player[]): MatchSetup {
  const hl = lineupForMatch(home, allPlayers);
  const al = lineupForMatch(away, allPlayers);
  const empty = { starters: [], subs: [] as Player[] };
  const homeXI = hl ? hl.starters : empty.starters;
  const awayXI = al ? al.starters : empty.starters;
  const homeSubs = hl ? hl.subs : [];
  const awaySubs = al ? al.subs : [];
  return { home, away, homeXI, awayXI, homeSubs, awaySubs, positions: (hl ?? al)?.positions ?? [] };
}

function emptyTeamStats() {
  return {
    controlledBallSeconds: 0,
    attackingThirdControlledSeconds: 0,
    possessions: 0,
    passes: 0,
    crosses: 0,
    carries: 0,
    dribbles: 0,
    turnovers: 0,
    highRecoveries: 0,
    counterattacks: 0,
    counterattackShots: 0,
    boxEntries: 0,
    shots: 0,
    shotsOnTarget: 0,
    xG: 0,
    corners: 0,
    fouls: 0,
    yellows: 0,
    reds: 0,
    offsides: 0,
    penalties: 0,
    injuries: 0,
  };
}

function emptyStats(): MatchStats {
  return { home: emptyTeamStats(), away: emptyTeamStats() };
}

export interface LiveCreateOpts {
  matchId: number;
  competitionId: number;
  fixtureId: number;
  homeNeutral?: boolean;
  decider?: boolean;
  compKind?: "league" | "cup" | "state" | "division";
  year?: number;
}

export function createLiveMatchState(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  opts: LiveCreateOpts
): LiveMatchState {
  const setup = setupMatch(home, away, allPlayers);
  const homeXI = setup.homeXI.length === 11 ? setup.homeXI : setup.homeSubs.slice(0, 11).concat(setup.homeXI).slice(0, 11);
  const awayXI = setup.awayXI.length === 11 ? setup.awayXI : setup.awaySubs.slice(0, 11).concat(setup.awayXI).slice(0, 11);
  const squad = [...homeXI, ...awayXI, ...setup.homeSubs, ...setup.awaySubs];
  const playerMinutes: Record<number, number> = {};
  const playerEnergy: Record<number, number> = {};
  for (const p of squad) {
    playerMinutes[p.id] = 0;
    playerEnergy[p.id] = p.energy;
  }
  const suspensionClears = allPlayers
    .filter((p) => (p.clubId === home.id || p.clubId === away.id) && p.suspendedGames > 0)
    .map((p) => p.id);
  const liveTactics = (club: Club) => ({
    formation: club.tactics.formation,
    style: engineStyle(club.tactics.style),
    pressing: enginePressing(club.tactics.pressing),
    direction: engineDirection(club.tactics.direction),
    familiarity: 50,
  });
  return {
    matchId: opts.matchId,
    fixtureId: opts.fixtureId,
    competitionId: opts.competitionId,
    homeClubId: home.id,
    awayClubId: away.id,
    homeNeutral: opts.homeNeutral ?? false,
    decider: opts.decider ?? false,
    compKind: opts.compKind ?? "league",
    year: opts.year ?? 1,
    homeXI: homeXI.map((p) => p.id),
    awayXI: awayXI.map((p) => p.id),
    homeSubs: setup.homeSubs.map((p) => p.id),
    awaySubs: setup.awaySubs.map((p) => p.id),
    homeOn: homeXI.map((p) => p.id),
    awayOn: awayXI.map((p) => p.id),
    usedSubs: [0, 0],
    subbedIn: [[], []],
    scores: [0, 0],
    stats: emptyStats(),
    events: [],
    half: 0,
    minute: 0,
    firstHalfLen: MS.timing.firstHalfEndSeconds / 60,
    secondHalfLen: (MS.timing.regulationSeconds - MS.timing.firstHalfEndSeconds) / 60,
    extraTimePlayed: false,
    withBall: 0,
    possessionCounts: [0, 0],
    playerYellows: {},
    subSlots: { gn: [[-1, -1, -1], [-1, -1, -1]], gm: [[-1, -1, -1, -1], [-1, -1, -1, -1]] },
    suspensionClears,
    playerMinutes,
    playerEnergy,
    ended: false,
    lastAdvancedAt: Date.now(),

    // Possession-state engine runtime
    matchClockSeconds: 0,
    period: 1,
    rngState: { seed: rng.seed, state: rng.state },
    controlledBallSeconds: [0, 0],
    attackingThirdControlledSeconds: [0, 0],
    phase: "BUILD_UP",
    zone: "DEF_CENTRAL",
    lane: "CENTRE",
    possessionStartType: "OPEN_PLAY",
    possessionAgeSeconds: 0,
    homeTactics: liveTactics(home),
    awayTactics: liveTactics(away),
    homeDefensiveOrganisation: 0,
    awayDefensiveOrganisation: 0,
    homeBaselineOrganisation: 0,
    awayBaselineOrganisation: 0,
    homeOrganisationRecoveryTime: 1,
    awayOrganisationRecoveryTime: 1,
    cards: [],
    injuries: [],
    substitutions: [],
    teamStats: { home: emptyTeamStats(), away: emptyTeamStats() },
    isCounter: false,
    possessionHighRecovery: false,
    opponentControlSeconds: [0, 0],
    pressureWindowAdvancedStates: [0, 0],
    pressureWindowStartSeconds: [0, 0],
    pendingRestart: null,
    possessionFirstAction: null,
  };
}

// ---------------------------------------------------------------------------
// Live tick + simulate
// ---------------------------------------------------------------------------

export interface LiveTickResult {
  events: MatchEvent[];
  finished: boolean;
  atHalfTime: boolean;
}

function centersFor(players: Player[]): AttributeCenters {
  // Centers reflect current player skills/availability. Do not cache by club
  // or player ids: development and fatigue mutate the inputs over a season.
  return computeAttributeCenters(players);
}

/** True when the match is paused at half-time (no clock running). */
export function isHalftime(st: LiveMatchState): boolean {
  return !st.ended && !st.extraTimePlayed && st.matchClockSeconds >= MS.timing.firstHalfEndSeconds &&
    (st.period === 1 || (st.period === 2 && st.matchClockSeconds === MS.timing.firstHalfEndSeconds));
}

export function isPregame(st: LiveMatchState): boolean {
  return !st.ended && !st.extraTimePlayed && st.period === 1 && st.matchClockSeconds === 0 && st.events.length === 0;
}

function halfTimeReached(st: LiveMatchState): boolean {
  return isHalftime(st);
}

export function livePhase(st: LiveMatchState): string {
  if (st.ended) return st.shootout ? "shootout" : "fulltime";
  if (isPregame(st)) return "pregame";
  if (isHalftime(st)) return "halftime";
  if (st.extraTimePlayed) return st.period === 1 ? "et1" : "et2";
  if (st.period === 1) return "first";
  return st.minute === 0 && st.matchClockSeconds > 0 ? "halftime" : "second";
}

export function tickLiveMatch(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  st: LiveMatchState,
  minutes: number,
  opts?: { resume?: boolean; ignoreHalfTime?: boolean }
): LiveTickResult {
  const beforeEvents = st.events.length;
  const centers = centersFor(allPlayers);
  // Pause at half-time for human viewers unless resuming.
  if (!opts?.ignoreHalfTime && !opts?.resume && halfTimeReached(st)) {
    return { events: [], finished: false, atHalfTime: true };
  }
  // Cap: a regular match cannot be advanced past full time.
  const regSeconds = MS.timing.regulationSeconds;
  const atPeriod1 = st.period === 1;
  const startClock = st.matchClockSeconds ?? 0;
  const target = Math.min(regSeconds, startClock + minutes * 60);
  // Pause exactly at the first-half boundary unless told to pass it.
  const firstHalfSeconds = MS.timing.firstHalfEndSeconds;
  let effectiveTarget = target;
  if (atPeriod1 && startClock < firstHalfSeconds && target >= firstHalfSeconds && !opts?.ignoreHalfTime && !opts?.resume) {
    effectiveTarget = firstHalfSeconds;
  }
  advancePossessionMatch(rng, home, away, allPlayers, st, Math.max(0, (effectiveTarget - startClock) / 60), centers);
  const newEvents = st.events.slice(beforeEvents);
  const finished = st.ended;
  const atHalfTime = isHalftime(st);
  return { events: newEvents, finished, atHalfTime };
}

export function simulateMatch(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  opts: { competitionId: number; fixtureId: number; homeNeutral?: boolean; decider?: boolean; compKind?: "league" | "cup" | "state" | "division"; year?: number; collectDiagnostics?: boolean }
) {
  const st = createLiveMatchState(rng, home, away, allPlayers, {
    matchId: opts.fixtureId,
    competitionId: opts.competitionId,
    fixtureId: opts.fixtureId,
    homeNeutral: opts.homeNeutral,
    decider: opts.decider,
    compKind: opts.compKind,
    year: opts.year,
  });
  const centers = centersFor(allPlayers);
  const simulationDiagnostics = opts.collectDiagnostics ? {
    actionCounts: {},
    phaseResidenceSeconds: {},
    restartCounts: {},
    possessionStarts: 0,
    deadBallSeconds: 0,
    controlledBallSeconds: [0, 0] as [number, number],
  } : undefined;
  simulatePossessionMatch(rng, home, away, allPlayers, st, centers, undefined, simulationDiagnostics);
  applyLiveMatchEnergy(st, allPlayers);
  const match = buildMatchFromState(st, home, away, allPlayers);
  if (simulationDiagnostics) match.simulationDiagnostics = simulationDiagnostics;
  return {
    match,
    homeGoals: st.scores[0],
    awayGoals: st.scores[1],
    suspensionClears: st.suspensionClears,
  };
}

/** Commit the fractional live-engine fatigue to the integer player model at a
 *  match boundary (instant simulation or live full-time). */
export function applyLiveMatchEnergy(st: LiveMatchState, allPlayers: Player[]): void {
  const byId = new Map(allPlayers.map((player) => [player.id, player]));
  for (const [id, energy] of Object.entries(st.playerEnergy ?? {})) {
    const player = byId.get(Number(id));
    if (player && Number.isFinite(energy)) player.energy = Math.max(1, Math.min(100, Math.round(energy)));
  }
}

// ---------------------------------------------------------------------------
// Match assembly from a live state
// ---------------------------------------------------------------------------

export function buildMatchFromState(st: LiveMatchState, home: Club, away: Club, allPlayers: Player[]): Match {
  const stats: MatchStats = st.teamStats
    ? { home: { ...st.teamStats.home }, away: { ...st.teamStats.away } }
    : st.stats;
  return {
    id: st.matchId,
    fixtureId: st.fixtureId,
    competitionId: st.competitionId,
    homeClubId: st.homeClubId,
    awayClubId: st.awayClubId,
    homeScore: st.scores[0],
    awayScore: st.scores[1],
    penaltyWinnerId: st.shootout?.winner ?? null,
    penaltyScore: st.shootout?.scores,
    events: st.events,
    stats,
    extraTime: st.extraTimePlayed,
    minuteEvents: [],
    minutes: { ...st.playerMinutes },
  };
}

// ---------------------------------------------------------------------------
// Live substitution
// ---------------------------------------------------------------------------

export interface LiveSubResult {
  event: MatchEvent | null;
  error?: string;
}

export function performLiveSub(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  st: LiveMatchState,
  side: number,
  outId: number,
  inId: number
): LiveSubResult {
  void rng;
  if (st.ended) return { event: null, error: "Match already finished" };
  if (side !== 0 && side !== 1) return { event: null, error: "Invalid team side" };
  const byId = new Map(allPlayers.map((p) => [p.id, p]));
  const on = side === 0 ? st.homeOn : st.awayOn;
  const bench = side === 0 ? st.homeSubs : st.awaySubs;
  const out = byId.get(outId);
  const inPlayer = byId.get(inId);
  if (!out) return { event: null, error: "Player not on the pitch" };
  if (!inPlayer) return { event: null, error: "Player not on the bench" };
  if (st.usedSubs[side] >= 5) return { event: null, error: "No substitutions left" };
  if (out.tacPos === 1 && inPlayer.position !== 0) return { event: null, error: "Replace the goalkeeper with another goalkeeper" };
  // Apply the substitution to the live state; the engine picks it up on next tick.
  const idx = on.indexOf(outId);
  if (idx < 0) return { event: null, error: "Player not on the pitch" };
  const bIdx = bench.indexOf(inId);
  if (bIdx < 0) return { event: null, error: "Player not on the bench" };
  inPlayer.tacPos = out.tacPos;
  on[idx] = inId;
  bench.splice(bIdx, 1);
  st.usedSubs[side]++;
  st.subbedIn[side].push(inId);
  const clubId = side === 0 ? home.id : away.id;
  const ev: MatchEvent = { minute: st.minute, half: st.period, type: EVENT_CODES.SUB, subtype: 0, clubId, playerId: outId, player2Id: inId, goalType: 0 };
  st.events.push(ev);
  st.substitutions.push({ minute: st.minute, outId, inId });
  return { event: ev };
}

// ---------------------------------------------------------------------------
// Human lineup rebuild (pregame/halftime)
// ---------------------------------------------------------------------------

export function rebuildLiveHumanLineup(st: LiveMatchState, humanClub: Club, allPlayers: Player[]): void {
  if (!isPregame(st) && !isHalftime(st)) return;
  const setup = lineupForMatch(humanClub, allPlayers);
  if (!setup) return;
  const xi = setup.starters.length === 11 ? setup.starters : setup.subs.slice(0, 11).concat(setup.starters).slice(0, 11);
  const xiIds = xi.map((p) => p.id);
  const subIds = setup.subs.map((p) => p.id);
  for (const id of [...xiIds, ...subIds]) {
    if (st.playerMinutes[id] === undefined) st.playerMinutes[id] = 0;
  }
  const home = st.homeClubId === humanClub.id;
  if (isPregame(st)) {
    if (home) {
      st.homeXI = xiIds;
      st.homeOn = xiIds.slice();
      st.homeSubs = subIds;
    } else {
      st.awayXI = xiIds;
      st.awayOn = xiIds.slice();
      st.awaySubs = subIds;
    }
    return;
  }

  // At half-time, preserve dismissals and injuries. Rebuilding the lineup must
  // not silently return a sent-off or injured player to the pitch.
  const sentOffIds = new Set(
    st.events
      .filter((event) => (event.type === EVENT_CODES.RED || event.type === EVENT_CODES.YELLOW_RED) && event.clubId === humanClub.id && event.playerId !== null)
      .map((event) => event.playerId as number),
  );
  const onIds = home ? st.homeOn : st.awayOn;
  const newOn: number[] = [];
  const used = new Set<number>();
  const eligibleXiIds = xiIds.filter((id) => {
    const player = allPlayers.find((candidate) => candidate.id === id);
    return player && player.injuryDays === 0 && !sentOffIds.has(id);
  });
  for (const slot of setup.positions) {
    const current = onIds.find((id) => {
      const player = allPlayers.find((candidate) => candidate.id === id);
      return player && !used.has(id) && player.injuryDays === 0 && !sentOffIds.has(id);
    });
    const chosen = current ?? eligibleXiIds.find((id) => !used.has(id));
    if (chosen === undefined) continue;
    const player = allPlayers.find((candidate) => candidate.id === chosen);
    if (player) player.tacPos = slot;
    newOn.push(chosen);
    used.add(chosen);
  }
  for (const id of eligibleXiIds) {
    if (newOn.length >= 11) break;
    if (!used.has(id)) {
      newOn.push(id);
      used.add(id);
    }
  }
  const remaining = setup.subs.filter((player) => !used.has(player.id) && !sentOffIds.has(player.id)).map((player) => player.id);
  if (home) {
    st.homeXI = newOn.slice();
    st.homeOn = newOn.slice();
    st.homeSubs = remaining;
    st.homeTactics = {
      formation: humanClub.tactics.formation,
      style: engineStyle(humanClub.tactics.style),
      pressing: enginePressing(humanClub.tactics.pressing),
      direction: engineDirection(humanClub.tactics.direction),
      familiarity: st.homeTactics?.familiarity ?? 50,
    };
  } else {
    st.awayXI = newOn.slice();
    st.awayOn = newOn.slice();
    st.awaySubs = remaining;
    st.awayTactics = {
      formation: humanClub.tactics.formation,
      style: engineStyle(humanClub.tactics.style),
      pressing: enginePressing(humanClub.tactics.pressing),
      direction: engineDirection(humanClub.tactics.direction),
      familiarity: st.awayTactics?.familiarity ?? 50,
    };
  }
}

// ---------------------------------------------------------------------------
// Post-match player effects
// ---------------------------------------------------------------------------

export function tribunalSuspension(rng: RngState): number {
  const roll = nextInt(rng, 100);
  if (roll < 60) return 1;
  if (roll < 85) return 2;
  if (roll < 95) return 3;
  if (roll < 99) return 5;
  return 10;
}

export function applyMatchToPlayers(match: Match, world: World) {
  const byId = new Map(world.players.map((p) => [p.id, p]));
  if (match.minutes) {
    for (const [id, minutes] of Object.entries(match.minutes)) {
      const p = byId.get(Number(id));
      if (!p) continue;
      const recorded = Math.round(minutes);
      p.recentMinutes = [recorded, ...(p.recentMinutes ?? [])].slice(0, DEVELOPMENT.recentMatchWindow);
    }
  }
  for (const ev of match.events) {
    const p = ev.playerId ? byId.get(ev.playerId) : null;
    if (!p) continue;
    if (ev.type === EVENT_CODES.YELLOW) {
      p.yellows++;
      if (p.yellows >= 3) {
        p.yellows = 0;
        p.suspendedGames = Math.max(p.suspendedGames, 1);
      }
    } else if (ev.type === EVENT_CODES.RED || ev.type === EVENT_CODES.YELLOW_RED) {
      p.reds++;
      const games = tribunalSuspension(world.rng);
      p.suspendedGames = Math.max(p.suspendedGames, games);
      const club = world.clubs.find((c) => c.id === ev.clubId);
      if (club) {
        const flavor = games >= 5 ? "after a violent challenge" : games >= 3 ? "for a serious foul" : "for foul play";
        world.news.push({
          dayIndex: world.dayIndex,
          text: `Tribunal suspends ${p.name} (${club.name}) for ${games} game${games > 1 ? "s" : ""} ${flavor}.`,
          kind: "tribunal",
          clubId: club.id,
        });
      }
      p.morale = Math.max(0, p.morale - 20);
    }
  }
}
