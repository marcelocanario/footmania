import type { Club, LiveMatchState, LiveTactics, Match, MatchEvent, MatchSimulationDiagnostics, MatchStats, Player, RngState, World } from "./types";
import { nextInt } from "./rng";
import { assignOnPitchToSlots, chooseAiTactics, currentScore, lineupForMatch } from "./club";
import { formationById } from "./formations";
import { DEVELOPMENT, DIRECTION_NAMES, EVENT_CODES, GOAL_SUBTYPES, PRESSING_NAMES, STYLE_NAMES } from "./constants";
import { leagueTurnKey } from "./calendar";

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
import { MP_CONFIG, gameConfig } from "../config";
import {
  canonicalFromLive,
  decayedStoredFamiliarity,
  effectiveFamiliarity,
  setupKeyFromCanonical,
  switchFamiliarity,
  type TacticFamiliarityMap,
} from "./familiarity";
import { currentSkillsVersion } from "./skillsVersion";
import { NEWS_SUBJECTS, publishNews } from "./news";
import { buildRoleBenchmarks, type RoleBenchmarks } from "./player-rating";
import { createRatingObserver, type RatingObserver } from "./ratingObserver";
import { tryDeployedRoleForSlot } from "./matchSim";
import { naturalDefaultRole } from "./positions";

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
}

export interface LiveTacticsUpdate {
  style?: number;
  pressing?: number;
  direction?: number;
}

/** Optional club context for the in-match familiarity switch penalty: the
 *  side's persistent per-setup progress map and the current game day. When
 *  omitted, a switched-to setup starts from the configured start floor. */
export interface LiveTacticsContext {
  familiarityMap?: TacticFamiliarityMap | null;
  absoluteGameDay?: number;
}

/**
 * Live-match tactics cooldown (config: liveMatch.tacticsCooldownMatchMinutes).
 * Returns the match-minutes a side must still wait before its next
 * style/pressing/direction change; 0 when unlocked. The first change of the
 * match is always free.
 */
export function tacticsCooldownMinutesRemaining(st: LiveMatchState, side: 0 | 1): number {
  if (st.ended) return 0;
  const lastChange = st.tacticsChangedAtMinute?.[side] ?? null;
  if (lastChange === null) return 0;
  const cooldown = MP_CONFIG.liveMatchTacticsCooldownMatchMinutes;
  return Math.max(0, Math.ceil(cooldown - (st.minute - lastChange)));
}

/** Apply the tactics that can be changed without rebuilding the lineup.
 *  Enforces the per-side tactics cooldown for every caller (REST, WebSocket
 *  and automation rules alike) so no pathway can bypass the lock. A change of
 *  setup also applies the plans/6 §17 switch penalty to that side's in-match
 *  familiarity: the new setup executes from max(start floor, its decayed
 *  stored progress) plus partial credit from the abandoned setup. */
/** §17 switch transfer on the live snapshot itself: any change of setup
 *  (style/pressing/direction/formation) trades execution quality immediately;
 *  the club's persistent map is only READ for the destination's stored
 *  progress, never written. Shared by every setup-change pathway so none can
 *  bypass the pricing. */
function priceLiveSetupSwitch(previous: LiveTactics, next: LiveTactics, context?: LiveTacticsContext): number {
  const prevCanonical = canonicalFromLive(previous);
  const nextCanonical = canonicalFromLive(next);
  const unchanged =
    prevCanonical.style === nextCanonical.style &&
    prevCanonical.pressing === nextCanonical.pressing &&
    prevCanonical.direction === nextCanonical.direction &&
    prevCanonical.formation === nextCanonical.formation;
  if (unchanged) return previous.familiarity;
  const dstDecayed = decayedStoredFamiliarity(context?.familiarityMap, setupKeyFromCanonical(nextCanonical), context?.absoluteGameDay);
  return switchFamiliarity(previous.familiarity, prevCanonical, nextCanonical, dstDecayed);
}

export function applyLiveTacticsUpdate(
  st: LiveMatchState,
  side: 0 | 1,
  input: LiveTacticsUpdate,
  context?: LiveTacticsContext
): string | null {
  if (st.ended) return "Match already finished";
  if (input.style === undefined && input.pressing === undefined && input.direction === undefined) return "At least one tactic is required";
  if (input.style !== undefined && (!Number.isInteger(input.style) || input.style < 0 || input.style >= STYLE_NAMES.length)) return "Invalid style";
  if (input.pressing !== undefined && (!Number.isInteger(input.pressing) || input.pressing < 0 || input.pressing >= PRESSING_NAMES.length)) return "Invalid pressing";
  if (input.direction !== undefined && (!Number.isInteger(input.direction) || input.direction < 0 || input.direction >= DIRECTION_NAMES.length)) return "Invalid direction";

  const remaining = tacticsCooldownMinutesRemaining(st, side);
  if (remaining > 0) return `Tactics are locked for ${remaining} more minute${remaining === 1 ? "" : "s"}`;

  const tactics = side === 0 ? st.homeTactics : st.awayTactics;
  const previous = { ...tactics };
  if (input.style !== undefined) tactics.style = engineStyle(input.style);
  if (input.pressing !== undefined) tactics.pressing = enginePressing(input.pressing);
  if (input.direction !== undefined) tactics.direction = engineDirection(input.direction);
  tactics.familiarity = priceLiveSetupSwitch(previous, tactics, context);

  // Record the change so the cooldown survives persistence and reloads.
  st.tacticsChangedAtMinute ??= [null, null];
  st.tacticsChangedAtMinute[side] = st.minute;
  return null;
}

/** Apply a formation change on a live side (pregame/halftime only — live play
 *  rebuilds the lineup instead). Formation is deliberately priced OUTSIDE the
 *  style/pressing/direction cooldown, but an actual shape change still pays
 *  the plans/6 §17 switch transfer so no setup-change pathway bypasses it. */
export function applyLiveFormationChange(
  st: LiveMatchState,
  side: 0 | 1,
  formation: number,
  context?: LiveTacticsContext
): string | null {
  if (st.ended) return "Match already finished";
  if (!isPregame(st) && !isHalftime(st)) return "Formation can only be changed before kickoff or at half-time";
  if (!Number.isInteger(formation) || !formationById(formation)) return "Invalid formation";
  const tactics = side === 0 ? st.homeTactics : st.awayTactics;
  const previous = { ...tactics };
  const candidate = { ...previous, formation };
  tactics.familiarity = priceLiveSetupSwitch(previous, candidate, context);
  tactics.formation = formation;
  return null;
}

export function setupMatch(home: Club, away: Club, allPlayers: Player[], options: { homeFutureFixtures?: boolean; awayFutureFixtures?: boolean } = {}): MatchSetup {
  const hl = lineupForMatch(home, allPlayers, { futureFixtures: options.homeFutureFixtures });
  const al = lineupForMatch(away, allPlayers, { futureFixtures: options.awayFutureFixtures });
  const empty = { starters: [], subs: [] as Player[] };
  const homeXI = hl ? hl.starters : empty.starters;
  const awayXI = al ? al.starters : empty.starters;
  const homeSubs = hl ? hl.subs : [];
  const awaySubs = al ? al.subs : [];
  return { home, away, homeXI, awayXI, homeSubs, awaySubs };
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
  absoluteGameDay?: number;
  roundsPerSeason?: number;
  matchSpacingDays?: number;
  /** Whether another league fixture follows this season for each side (plan 9 §21.4). */
  homeFutureFixtures?: boolean;
  awayFutureFixtures?: boolean;
}

export function createLiveMatchState(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  opts: LiveCreateOpts
): LiveMatchState {
  // AI clubs pick the starting tactic that best fits their current squad
  // (injuries, fatigue, rotation) before the lineups are built; humans keep
  // whatever they saved. Deterministic, own-squad only.
  if (!home.isHuman) chooseAiTactics(home, allPlayers);
  if (!away.isHuman) chooseAiTactics(away, allPlayers);
  const setup = setupMatch(home, away, allPlayers, { homeFutureFixtures: opts.homeFutureFixtures, awayFutureFixtures: opts.awayFutureFixtures });
  const homeXI = setup.homeXI.length === 11 ? setup.homeXI : setup.homeSubs.slice(0, 11).concat(setup.homeXI).slice(0, 11);
  const awayXI = setup.awayXI.length === 11 ? setup.awayXI : setup.awaySubs.slice(0, 11).concat(setup.awayXI).slice(0, 11);
  // §9.1: build the live slot maps from the lineup starter order (starter i
  // maps to formation.slots[i]).
  const homeSlotByPlayerId: Record<number, number> = {};
  const awaySlotByPlayerId: Record<number, number> = {};
  homeXI.forEach((p, i) => { homeSlotByPlayerId[p.id] = i; });
  awayXI.forEach((p, i) => { awaySlotByPlayerId[p.id] = i; });
  const squad = [...homeXI, ...awayXI, ...setup.homeSubs, ...setup.awaySubs];
  const playerMinutes: Record<number, number> = {};
  const playerEnergy: Record<number, number> = {};
  const playerRecentLoad: Record<number, number> = {};
  const playerMatchLoad: Record<number, number> = {};
  const playerPreMatchLoad: Record<number, number> = {};
  for (const p of squad) {
    playerMinutes[p.id] = 0;
    playerEnergy[p.id] = p.energy;
    playerRecentLoad[p.id] = p.recentLoad ?? 0;
    playerPreMatchLoad[p.id] = p.recentLoad ?? 0;
    playerMatchLoad[p.id] = 0;
  }
  const suspensionClears = allPlayers
    .filter((p) => (p.clubId === home.id || p.clubId === away.id) && p.suspendedGames > 0)
    .map((p) => p.id);
  const liveTactics = (club: Club) => ({
    formation: club.tactics.formation,
    style: engineStyle(club.tactics.style),
    pressing: enginePressing(club.tactics.pressing),
    direction: engineDirection(club.tactics.direction),
    // §17: the side executes tonight's setup at its drilled (and lazily
    // decayed) familiarity; missing progress reads as neutral 50.
    familiarity: effectiveFamiliarity(club, opts.absoluteGameDay),
  });
  // Coin toss: winner kicks off first half, loser kicks off second half. Use the
  // seeded RNG so the result is deterministic and survives reloads via rngState.
  const coinTossWinner = (nextInt(rng, 2) as 0 | 1);
  const withBall = coinTossWinner;
  const coinTossEvent: MatchEvent = {
    minute: 0,
    half: 0,
    type: EVENT_CODES.COIN_TOSS,
    subtype: 0,
    clubId: withBall === 0 ? home.id : away.id,
    playerId: null,
    player2Id: null,
    goalType: 0,
  };
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
    homeSlotByPlayerId,
    awaySlotByPlayerId,
    usedSubs: [0, 0],
    subbedIn: [[], []],
    scores: [0, 0],
    stats: emptyStats(),
    events: [coinTossEvent],
    half: 0,
    minute: 0,
    firstHalfLen: MS.timing.firstHalfEndSeconds / 60,
    secondHalfLen: (MS.timing.regulationSeconds - MS.timing.firstHalfEndSeconds) / 60,
    extraTimePlayed: false,
    withBall,
    coinTossWinner,
    firstHalfAddedMinutes: 0,
    secondHalfAddedMinutes: 0,
    halftimeStartedAt: null,
    halftimeReady: [false, false],
    possessionCounts: [0, 0],
    playerYellows: {},
    subSlots: { gn: [[-1, -1, -1], [-1, -1, -1]], gm: [[-1, -1, -1, -1], [-1, -1, -1, -1]] },
    suspensionClears,
    playerMinutes,
    playerEnergy,
    playerRecentLoad,
    playerMatchLoad,
    playerPreMatchLoad,
    absoluteGameDay: opts.absoluteGameDay,
    roundsPerSeason: opts.roundsPerSeason,
    matchSpacingDays: opts.matchSpacingDays,
    ended: false,
    lastAdvancedAt: Date.now(),

    // Possession-state engine runtime
    matchClockSeconds: 0,
    targetMatchClockSeconds: 0,
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
    automationFiredRuleIds: [],
    automationDisabled: [false, false],
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

/** Build the rating observer for a match (plan §17). Same-role benchmarks are
 *  computed once per match from the world's senior population; the observer
 *  accumulates into st.ratingAccum (persisted across streamed ticks). When the
 *  world has no ratings enabled this returns null (engine stays byte-identical). */
export function ratingObserverFor(st: LiveMatchState, allPlayers: Player[]): RatingObserver | null {
  if (!allPlayers || allPlayers.length === 0) return null;
  const byId = new Map(allPlayers.map((p) => [p.id, p]));
  // Roles are derived from the LIVE slot maps (st.homeSlotByPlayerId /
  // st.awaySlotByPlayerId) because the engine resolves deployed roles from the
  // formation + live assignment; Player rows never store deployed state.
  const deployedRoleOf = (p: Player): string => {
    const home = tryDeployedRoleForSlot(st.homeSlotByPlayerId, st.homeTactics.formation, p.id);
    if (home) return home.role;
    const away = tryDeployedRoleForSlot(st.awaySlotByPlayerId, st.awayTactics.formation, p.id);
    if (away) return away.role;
    // Benched (or otherwise unmapped): benchmarks use the natural default role.
    return naturalDefaultRole(p.position as import("./positions").NaturalPosition);
  };
  // Freeze the same-role benchmarks at kickoff and persist the snapshot on the
  // live state. Streamed ticks and server reloads reuse the SAME snapshot so
  // ratings cannot drift when player data or slot assignments change
  // mid-match.
  let benchmarks = st.ratingBenchmarksJson ? (() => {
    try {
      return JSON.parse(st.ratingBenchmarksJson) as RoleBenchmarks;
    } catch {
      return null;
    }
  })() : null;
  if (!benchmarks) {
    benchmarks = buildRoleBenchmarks(allPlayers, deployedRoleOf);
    st.ratingBenchmarksJson = JSON.stringify(benchmarks);
  }
  st.ratingAccum ??= {};
  return createRatingObserver({
    benchmarks,
    fineRoleOf: (playerId) => {
      const p = byId.get(playerId);
      return p ? deployedRoleOf(p) : "ST";
    },
    base: st.ratingAccum,
  });
}

// centersFor is called on every live-match tick (and once per instant
// simulation) with the same `world.players` array reference across an entire
// advanceLiveMatches() batch. Every mutation site that changes a skill
// computeAttributeCenters reads, or the world.players population via push,
// calls bumpSkillsVersion() (array *reassignment*, e.g. a retiree filter,
// already changes the array reference and self-invalidates below). Caching
// on (array identity, version) reuses the same centers across that whole
// batch instead of re-sorting the entire player pool on every tick.
let cachedCentersPlayers: Player[] | null = null;
let cachedCentersVersion = -1;
let cachedCenters: AttributeCenters | null = null;

function centersFor(players: Player[]): AttributeCenters {
  const version = currentSkillsVersion();
  if (cachedCenters && cachedCentersPlayers === players && cachedCentersVersion === version) {
    return cachedCenters;
  }
  cachedCenters = computeAttributeCenters(players);
  cachedCentersPlayers = players;
  cachedCentersVersion = version;
  return cachedCenters;
}

/** True when the match is paused at half-time (no clock running). */
export function isHalftime(st: LiveMatchState): boolean {
  const firstEnd = MS.timing.firstHalfEndSeconds + (st.firstHalfAddedMinutes ?? 0) * 60;
  // Before added time is computed the raw 2700 still acts as halftime boundary;
  // once added is frozen the interval extends.
  const atFirstHalfEnd = st.matchClockSeconds >= firstEnd;
  return !st.ended && !st.extraTimePlayed && atFirstHalfEnd &&
    (st.period === 1 || (st.period === 2 && st.matchClockSeconds === firstEnd));
}

export function isPregame(st: LiveMatchState): boolean {
  // Coin toss adds an event at 0' so we cannot rely on events.length.
  return !st.ended && !st.extraTimePlayed && st.period === 1 && st.matchClockSeconds === 0;
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

/** Resolve whether a side is controlled by a human (ownerUserId set). */
function isHumanSide(world: { clubs: Club[] }, clubId: number): boolean {
  const club = world.clubs.find((c) => c.id === clubId);
  return !!club?.ownerUserId;
}

/** Whether this live match involves at least one human team. */
export function involvesHuman(world: World, st: LiveMatchState): boolean {
  return isHumanSide(world, st.homeClubId) || isHumanSide(world, st.awayClubId);
}

/** Mark a human side ready to resume after halftime. Returns true if the match should now resume. */
export function markHalftimeReady(world: World, st: LiveMatchState, side: 0 | 1): boolean {
  if (!isHalftime(st)) return false;
  if (!involvesHuman(world, st)) return true;
  st.halftimeReady ??= [false, false];
  st.halftimeReady[side] = true;
  const needsHome = isHumanSide(world, st.homeClubId);
  const needsAway = isHumanSide(world, st.awayClubId);
  const homeReady = !needsHome || st.halftimeReady[0];
  const awayReady = !needsAway || st.halftimeReady[1];
  return homeReady && awayReady;
}

export function clearHalftimeState(st: LiveMatchState): void {
  st.halftimeStartedAt = null;
  st.halftimeReady = [false, false];
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
    // Initialize wall-clock halftime anchor for human matches (world.ts is authoritative,
    // but a direct tick via routes/ws should also stamp it so the countdown is visible).
    if (st.halftimeStartedAt == null) st.halftimeStartedAt = Date.now();
    return { events: [], finished: false, atHalfTime: true };
  }
  // If resuming, clear the halftime wall-clock state.
  if (opts?.resume && isHalftime(st)) {
    clearHalftimeState(st);
  }
  const atPeriod1 = st.period === 1;
  const startClock = st.matchClockSeconds ?? 0;
  // Advance a nominal timeline, not the already-overshot simulated clock. A
  // possession action may finish after the requested target; using the actual
  // clock as the next tick's starting point would compound that overrun and
  // make streamed matches consume a different RNG path from instant matches.
  const targetClock = (st.targetMatchClockSeconds ?? startClock) + minutes * 60;
  st.targetMatchClockSeconds = targetClock;
  // Total regulation end including any already-frozen added time (first + second).
  const totalRegSeconds = MS.timing.regulationSeconds + (st.firstHalfAddedMinutes ?? 0) * 60 + (st.secondHalfAddedMinutes ?? 0) * 60;
  const target = Math.min(totalRegSeconds, targetClock);
  const rawFirst = MS.timing.firstHalfEndSeconds;
  const pauseAtHalftime = atPeriod1 && !opts?.ignoreHalfTime && !opts?.resume && target >= rawFirst;

  const ratingObserver = ratingObserverFor(st, allPlayers);
  advancePossessionMatch(rng, home, away, allPlayers, st, Math.max(0, (target - startClock) / 60), centers, { pauseAtHalftime, ...(ratingObserver ? { ratingObserver } : {}) });
  const newEvents = st.events.slice(beforeEvents);
  const finished = st.ended;
  const atHalfTime = isHalftime(st);
  // Stamp halftime wall-clock on entry so the UI can show a countdown even before the worker ticks again.
  if (atHalfTime && st.halftimeStartedAt == null) st.halftimeStartedAt = Date.now();
  return { events: newEvents, finished, atHalfTime };
}

export function simulateMatch(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  opts: { competitionId: number; fixtureId: number; matchId?: number; homeNeutral?: boolean; decider?: boolean; compKind?: "league" | "cup" | "state" | "division"; year?: number; collectDiagnostics?: boolean; absoluteGameDay?: number; roundsPerSeason?: number; matchSpacingDays?: number }
) {
  const st = createLiveMatchState(rng, home, away, allPlayers, {
    matchId: opts.matchId ?? opts.fixtureId,
    competitionId: opts.competitionId,
    fixtureId: opts.fixtureId,
    homeNeutral: opts.homeNeutral,
    decider: opts.decider,
    compKind: opts.compKind,
    year: opts.year,
    // Injury durations are anchored to the absolute game day. Callers that
    // simulate real fixtures instantly (admin round advance, division
    // history) MUST pass this; without it injuries would be anchored to day 0
    // and expire immediately.
    absoluteGameDay: opts.absoluteGameDay,
    roundsPerSeason: opts.roundsPerSeason,
    matchSpacingDays: opts.matchSpacingDays,
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
  const ratingObserver = ratingObserverFor(st, allPlayers);
  // §22.2 instant/streamed equivalence: an instant simulation must consume the
  // SAME engine boundary cadence as a streamed match, otherwise added-time
  // freezing and the per-minute RNG progression diverge. Drive the instant run
  // through the identical cumulative-target progression tickLiveMatch uses.
  st.targetMatchClockSeconds = 0;
  let guard = 0;
  const diagAccum: MatchSimulationDiagnostics | undefined = simulationDiagnostics
    ? { actionCounts: {}, phaseResidenceSeconds: {}, restartCounts: {}, possessionStarts: 0, deadBallSeconds: 0, controlledBallSeconds: [0, 0] }
    : undefined;
  while (!st.ended && guard++ < 120) {
    st.targetMatchClockSeconds = (st.targetMatchClockSeconds ?? 0) + 60;
    // controlledBallSeconds is initialized cumulatively from the live state on
    // each engine rebuild, so capture the pre-chunk values to compute deltas.
    const prevControlled = st.controlledBallSeconds ? [...st.controlledBallSeconds] : [0, 0];
    const chunkDiag: MatchSimulationDiagnostics | undefined = diagAccum
      ? { actionCounts: {}, phaseResidenceSeconds: {}, restartCounts: {}, possessionStarts: 0, deadBallSeconds: 0, controlledBallSeconds: [0, 0] }
      : undefined;
    simulatePossessionMatch(rng, home, away, allPlayers, st, centers, st.targetMatchClockSeconds, chunkDiag, ratingObserver ?? undefined);
    if (chunkDiag && diagAccum) {
      for (const [k, v] of Object.entries(chunkDiag.actionCounts)) diagAccum.actionCounts[k] = (diagAccum.actionCounts[k] ?? 0) + v;
      for (const [k, v] of Object.entries(chunkDiag.phaseResidenceSeconds)) diagAccum.phaseResidenceSeconds[k] = (diagAccum.phaseResidenceSeconds[k] ?? 0) + v;
      for (const [k, v] of Object.entries(chunkDiag.restartCounts)) diagAccum.restartCounts[k] = (diagAccum.restartCounts[k] ?? 0) + v;
      diagAccum.possessionStarts += chunkDiag.possessionStarts;
      diagAccum.deadBallSeconds += chunkDiag.deadBallSeconds;
      const postControlled = st.controlledBallSeconds ?? [0, 0];
      diagAccum.controlledBallSeconds[0] += postControlled[0] - prevControlled[0];
      diagAccum.controlledBallSeconds[1] += postControlled[1] - prevControlled[1];
    }
  }
  if (simulationDiagnostics && diagAccum) {
    simulationDiagnostics.actionCounts = diagAccum.actionCounts;
    simulationDiagnostics.phaseResidenceSeconds = diagAccum.phaseResidenceSeconds;
    simulationDiagnostics.restartCounts = diagAccum.restartCounts;
    simulationDiagnostics.possessionStarts = diagAccum.possessionStarts;
    simulationDiagnostics.deadBallSeconds = diagAccum.deadBallSeconds;
    simulationDiagnostics.controlledBallSeconds = diagAccum.controlledBallSeconds;
  }
  applyLiveMatchEnergy(st, allPlayers);
  const match = buildMatchFromState(st, home, away, allPlayers);
  if (simulationDiagnostics) match.simulationDiagnostics = simulationDiagnostics;
  // The possession engine no longer credits goals directly (instant runs share
  // the same engine as live ticks, where per-tick Player mutations would be
  // lost). Attribute this match's goals/assists from its authoritative events.
  applyMatchGoalsToPlayers(match, allPlayers);
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
  const pre = st.playerPreMatchLoad ?? {};
  const loads = st.playerMatchLoad ?? {};
  for (const [id, matchLoad] of Object.entries(loads)) {
    const player = byId.get(Number(id));
    if (!player || !Number.isFinite(matchLoad)) continue;
    player.recentLoad = Math.min(6, (pre[Number(id)] ?? player.recentLoad ?? 0) + matchLoad);
  }
}

// ---------------------------------------------------------------------------
// Match assembly from a live state
// ---------------------------------------------------------------------------

export function buildMatchFromState(st: LiveMatchState, home: Club, away: Club, allPlayers: Player[]): Match {
  const stats: MatchStats = st.teamStats
    ? { home: { ...st.teamStats.home }, away: { ...st.teamStats.away } }
    : st.stats;
  const minutes = { ...st.playerMinutes };
  // MVP is decided at finalization from the ratings (highest rating on the
  // winning team) — never inside the replay-stable engine path, so instant and
  // streamed digests stay byte-identical. mvpPlayerId is set by the caller.
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
    minutes,
    ratingAccum: st.ratingAccum,
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
  if (st.usedSubs[side] >= MP_CONFIG.maxSubsPerSide) return { event: null, error: "No substitutions left" };
  // §9.5: an incoming GK is required only when replacing the GK slot; a GK
  // can never enter an outfield slot.
  const slotMap = side === 0 ? st.homeSlotByPlayerId : st.awaySlotByPlayerId;
  const tactics = side === 0 ? st.homeTactics : st.awayTactics;
  const resolvedOut = tactics ? tryDeployedRoleForSlot(slotMap, tactics.formation, outId) : null;
  const slotIndex = resolvedOut?.slotIndex;
  const outRole = resolvedOut?.role ?? naturalDefaultRole(out.position as import("./positions").NaturalPosition);
  if (outRole === "GK" && (inPlayer.position as string) !== "GK") {
    return { event: null, error: "Replace the goalkeeper with another goalkeeper" };
  }
  if (outRole !== "GK" && (inPlayer.position as string) === "GK") {
    return { event: null, error: "A goalkeeper cannot enter an outfield slot" };
  }
  // Apply the substitution to the live state; the engine picks it up on next tick.
  const idx = on.indexOf(outId);
  if (idx < 0) return { event: null, error: "Player not on the pitch" };
  const bIdx = bench.indexOf(inId);
  if (bIdx < 0) return { event: null, error: "Player not on the bench" };
  // §9.1: every incoming player inherits the exact outgoing slot index.
  if (slotMap && slotIndex !== undefined) {
    slotMap[inId] = slotIndex;
    delete slotMap[outId];
  }
  on[idx] = inId;
  bench.splice(bIdx, 1);
  st.usedSubs[side]++;
  st.subbedIn[side].push(inId);
  // Seed the fatigue/workload maps for the incoming player so full-time commit
  // is explicit and idempotent: energy starts from his persisted value and the
  // match-load counter starts at zero (plan §26 substitution rules).
  st.playerEnergy ??= {};
  st.playerEnergy[inId] = inPlayer.energy;
  st.playerPreMatchLoad ??= {};
  st.playerPreMatchLoad[inId] = inPlayer.recentLoad ?? 0;
  st.playerMatchLoad ??= {};
  st.playerMatchLoad[inId] = 0;
  const clubId = side === 0 ? home.id : away.id;
  const ev: MatchEvent = { minute: st.minute, half: st.period, type: EVENT_CODES.SUB, subtype: 0, clubId, playerId: outId, player2Id: inId, goalType: 0 };
  st.events.push(ev);
  st.substitutions.push({ minute: st.minute, outId, inId });
  return { event: ev };
}

// ---------------------------------------------------------------------------
// Human lineup rebuild (pregame/halftime)
// ---------------------------------------------------------------------------

export function rebuildLiveHumanLineup(
  st: LiveMatchState,
  humanClub: Club,
  allPlayers: Player[],
  opts: { absoluteGameDay?: number } = {}
): void {
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
      st.homeSlotByPlayerId = Object.fromEntries(setup.starters.map((p, i) => [p.id, i]));
    } else {
      st.awayXI = xiIds;
      st.awayOn = xiIds.slice();
      st.awaySubs = subIds;
      st.awaySlotByPlayerId = Object.fromEntries(setup.starters.map((p, i) => [p.id, i]));
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
  const byId = new Map(allPlayers.map((p) => [p.id, p]));
  const stillPlaying = (id: number): Player | null => {
    const player = byId.get(id);
    return player && player.injuryDays === 0 && !sentOffIds.has(id) ? player : null;
  };
  // §9.1: a formation change never substitutes anyone. Re-slot exactly the
  // players already on the pitch with the same assignment DP the lineup builder
  // uses, allowing slots to remain empty when the side is short. Sequentially
  // filling slots from `homeOn` order (the previous behaviour) ignored role
  // compatibility entirely: one dismissal shifted every player one slot along,
  // and a dismissed goalkeeper handed the GK slot to an outfielder.
  const onPitch = onIds.map(stillPlaying).filter((p): p is Player => !!p);
  const formationId = humanClub.tactics.formation;
  const assign = assignOnPitchToSlots(onPitch, formationId, (p, role) => currentScore(p, role));
  const newSlotByPlayerId: Record<number, number> = {};
  const newOn: number[] = [];
  const used = new Set<number>();
  if (assign) {
    for (let slotIndex = 0; slotIndex < assign.length; slotIndex++) {
      const id = assign[slotIndex];
      if (id === null) continue;
      newSlotByPlayerId[id] = slotIndex;
      newOn.push(id);
      used.add(id);
    }
  }
  // A player on the pitch whom no slot can legally hold (only possible for a
  // natural GK once the GK slot is taken) stays on the pitch unslotted rather
  // than being silently removed; he is picked up by the next rebuild.
  for (const player of onPitch) {
    if (!used.has(player.id)) {
      newOn.push(player.id);
      used.add(player.id);
    }
  }
  const remaining = setup.subs.filter((player) => !used.has(player.id) && !sentOffIds.has(player.id)).map((player) => player.id);
  // An interval rebuild picks up whatever setup the manager saved on the club
  // (formation AND style/pressing/direction). Any actual delta against the
  // snapshot the side has been executing pays the §17 transfer; an unchanged
  // rebuild is free. This closes the last free-pickup pathway.
  const context = {
    familiarityMap: humanClub.tacticFamiliarity,
    absoluteGameDay: opts.absoluteGameDay,
  };
  if (home) {
    st.homeXI = newOn.slice();
    st.homeOn = newOn.slice();
    st.homeSubs = remaining;
    st.homeSlotByPlayerId = newSlotByPlayerId;
    const previous = st.homeTactics;
    const next = {
      formation: humanClub.tactics.formation,
      style: engineStyle(humanClub.tactics.style),
      pressing: enginePressing(humanClub.tactics.pressing),
      direction: engineDirection(humanClub.tactics.direction),
      familiarity: previous?.familiarity ?? 50,
    };
    st.homeTactics = { ...next, familiarity: previous ? priceLiveSetupSwitch(previous, next, context) : next.familiarity };
  } else {
    st.awayXI = newOn.slice();
    st.awayOn = newOn.slice();
    st.awaySubs = remaining;
    st.awaySlotByPlayerId = newSlotByPlayerId;
    const previous = st.awayTactics;
    const next = {
      formation: humanClub.tactics.formation,
      style: engineStyle(humanClub.tactics.style),
      pressing: enginePressing(humanClub.tactics.pressing),
      direction: engineDirection(humanClub.tactics.direction),
      familiarity: previous?.familiarity ?? 50,
    };
    st.awayTactics = { ...next, familiarity: previous ? priceLiveSetupSwitch(previous, next, context) : next.familiarity };
  }
}

// ---------------------------------------------------------------------------
// Post-match player effects
// ---------------------------------------------------------------------------

/**
 * Pure red-card tribunal mapping: games = round(base + lnCoefficient * ln(X))
 * for a uniform draw X in 1..100 (discipline config). Clamped to at least one
 * fixture. Exported for tests.
 */
export function tribunalGamesForDraw(x: number): number {
  const { tribunalBase, tribunalLnCoefficient } = gameConfig.discipline;
  return Math.max(1, Math.round(tribunalBase + tribunalLnCoefficient * Math.log(x)));
}

/**
 * Red-card tribunal. Draws one uniform integer 1..100 from the world RNG and
 * maps it through the configured log model. Post-match only: exactly one RNG
 * draw per red card, never consulted by the match engine itself.
 */
export function tribunalSuspension(rng: RngState): number {
  return tribunalGamesForDraw(nextInt(rng, 100) + 1);
}

/** Credit a finalized match's goals and assists to player counters, from the
 *  authoritative GOAL events. Shootout penalties never count toward season or
 *  career totals (regulation penalties carry goalType NORMAL and do count).
 *  Shared by the live full-time commit (applyMatchToPlayers) and instant
 *  simulations (simulateMatch), which the possession engine no longer credits
 *  directly because live ticks persist only the match state, not Player rows. */
export function applyMatchGoalsToPlayers(match: Match, players: Player[]): void {
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const ev of match.events) {
    if (ev.type !== EVENT_CODES.GOAL || ev.goalType === GOAL_SUBTYPES.PENALTY) continue;
    if (ev.playerId !== null) {
      const scorer = byId.get(ev.playerId);
      if (scorer) {
        scorer.seasonGoals++;
        scorer.careerGoals++;
      }
    }
    if (ev.player2Id !== null) {
      const assister = byId.get(ev.player2Id);
      if (assister) {
        assister.seasonAssists++;
        assister.careerAssists++;
      }
    }
  }
  // MVP award: credited once per finalized match from the authoritative
  // match-level mvpPlayerId. Post-match only; never consumed by the match
  // engine. Shared by the live full-time commit (applyMatchToPlayers) and
  // instant simulations (simulateMatch), exactly like the goal counters.
  applyMatchMvpToPlayers(match.mvpPlayerId, players);
}

/** Credit an already-finalized MVP exactly once at the caller's match
 * finalization boundary. Kept separate from goals so instant simulations can
 * select the rating-based MVP after their goal effects have been applied. */
export function applyMatchMvpToPlayers(mvpPlayerId: number | null | undefined, players: Player[]): void {
  if (mvpPlayerId === null || mvpPlayerId === undefined) return;
  const p = players.find((player) => player.id === mvpPlayerId);
  if (!p) return;
  p.careerMvps = (p.careerMvps ?? 0) + 1;
  p.seasonMvps = (p.seasonMvps ?? 0) + 1;
}

/**
 * Per-league-turn yellow-card accumulation (discipline config). Bookings count
 * only within one league turn: the stable yellowsTurnKey makes stale counters
 * expire at every turn boundary without an explicit reset sweep. Reaching the
 * limit inside a turn bans the player and zeroes the counter, so a fresh
 * accumulation window opens once the ban is served. Post-match only — reads
 * the finalized fixture's round and never touches engine state.
 */
function applyTurnYellow(world: World, p: Player, match: Match): void {
  const fixture = world.fixtures.find((f) => f.id === match.fixtureId);
  if (!fixture) return; // practice/history sims have no committed fixture row
  const { turnYellowLimit, turnYellowBanGames } = gameConfig.discipline;
  const key = leagueTurnKey(world.mp.seasonNumber ?? 0, fixture.round);
  if ((p.yellowsTurnKey ?? null) !== key) {
    p.yellowsTurnKey = key;
    p.turnYellows = 0;
  }
  p.turnYellows = (p.turnYellows ?? 0) + 1;
  if (p.turnYellows >= turnYellowLimit) {
    p.turnYellows = 0;
    p.yellowsTurnKey = null;
    p.suspendedGames = Math.max(p.suspendedGames, turnYellowBanGames);
  }
}

export function applyMatchToPlayers(match: Match, world: World) {
  const byId = new Map(world.players.map((p) => [p.id, p]));
  applyMatchGoalsToPlayers(match, world.players);
  if (match.minutes) {
    for (const [id, minutes] of Object.entries(match.minutes)) {
      const p = byId.get(Number(id));
      if (!p) continue;
      const recorded = Math.round(minutes);
      p.recentMinutes = [recorded, ...(p.recentMinutes ?? [])].slice(0, DEVELOPMENT.recentMatchWindow);
      // Any pitch time counts as an appearance for season-award eligibility.
      // applyMatchToPlayers runs once per finalized competitive match; practice
      // matches simulate on cloned worlds and never reach this path.
      if (minutes > 0) p.seasonAppearances = (p.seasonAppearances ?? 0) + 1;
    }
  }
  for (const ev of match.events) {
    const p = ev.playerId ? byId.get(ev.playerId) : null;
    if (!p) continue;
    if (ev.type === EVENT_CODES.YELLOW) {
      // Season total (season history, awards, profile). Never resets mid-season;
      // per-turn accumulation is tracked separately by applyTurnYellow.
      p.yellows++;
      applyTurnYellow(world, p, match);
    } else if (ev.type === EVENT_CODES.RED || ev.type === EVENT_CODES.YELLOW_RED) {
      p.reds++;
      const games = tribunalSuspension(world.rng);
      p.suspendedGames = Math.max(p.suspendedGames, games);
      const club = world.clubs.find((c) => c.id === ev.clubId);
      if (club) {
        const flavor = games >= 5 ? "after a violent challenge" : games >= 3 ? "for a serious foul" : "for foul play";
        publishNews(world, {
          kind: "tribunal",
          subject: NEWS_SUBJECTS.tribunal,
          clubId: club.id,
          headline: "Disciplinary verdicts",
          entries: [{ key: `ban:${p.id}`, label: p.name, detail: `(${club.name}) suspended for ${games} game${games > 1 ? "s" : ""} ${flavor}` }],
        });
      }
    }
  }
}
