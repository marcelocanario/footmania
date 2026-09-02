import type { Club, LiveBallAction, LiveCardState, LiveInjuryState, LiveMatchState, LiveSubstitutionState, LiveTactics, MatchEvent, MatchSimulationDiagnostics, Player, RngState, TeamMatchStats, World } from "./types";
import { MATCH_SIMULATOR_CONFIG as MS, INFLUENCE_SCALES } from "../matchSimulatorConfig";
import { nextDouble, nextInt, gamma } from "./rng";
import { EVENT_CODES, GOAL_SUBTYPES } from "./constants";
import type { RatingObserver, RatingDecisionInput } from "./ratingObserver";
import { ENERGY_INJURY_MODEL, energyLoss, injuryRiskMultiplier, loadIncrement, physicalSkill, readiness, recordInjury } from "./energyInjury";
import { gameConfig, MP_CONFIG } from "../config";
import { tacticalSkillRating } from "./rating";
import { INITIAL_FAMILIARITY, tacticalExecution, tacticalExecutionContrast } from "./familiarity";
import { remainingPlayerWorkloadMultiplier } from "./numericalDisadvantage";
import type { DeployedRole, NaturalPosition } from "./positions";
import { adjustedTacticalRating as adjustedRoleRating, effectiveSkillsOrFloor } from "./outOfPosition";
import { formationById } from "./formations";
import { playerIndexFor } from "./playerIndex";
import { currentSkillsVersion } from "./skillsVersion";

// ---------------------------------------------------------------------------
// Possession-state match engine (plans/6. match-simulator-overhaul.md).
//
// Self-contained, seeded, config-driven. Every behavioral coefficient comes
// from `MATCH_SIMULATOR_CONFIG` (game.config.jsonc influence + the
// match-simulator.jsonc model). The only module-local numbers are mathematical
// constants and derived-from-config quantities.
// ---------------------------------------------------------------------------

export type MatchPhase = "SET_PIECE" | "TRANSITION" | "BUILD_UP" | "PROGRESSION" | "FINAL_THIRD";
export type MatchZone = "DEF_WIDE" | "DEF_CENTRAL" | "MID_WIDE" | "MID_CENTRAL" | "ATT_WIDE" | "ATT_CENTRAL" | "BOX";
export type Lane = "LEFT" | "CENTRE" | "RIGHT";
export type IntentAction = "PASS" | "CROSS" | "CARRY" | "DRIBBLE" | "SHOT" | "CLEARANCE";
export type FailureAction = "MISCONTROL" | "DISPOSSESSED";
export type Outcome = "CONTINUE" | "TURNOVER" | "FOUL" | "RETAINED_RESTART";
export type RestartType = "THROW_IN" | "FREE_KICK" | "GOAL_KICK" | "CORNER" | "KICK_OFF" | "PENALTY";

export interface LivePlayerState {
  id: number;
  skills: { gol: number; pace: number; tec: number; pas: number; des: number; playmaking: number; fin: number };
  overall: number;
  age: number;
  position: NaturalPosition;
  /** Deployed role resolved from the side's formation + live slot map (§9.1). */
  deployedRole: DeployedRole;
  slotIndex: number;
  energy: number;
  readiness: number;
  zTech: number;
  zPace: number;
  zPhysical: number;
  zFinishing: number;
  zGk: number;
  zDefending: number;
  zPassing: number;
  zPlaymaking: number;
  /** Readiness-invariant robust-Z of each canonical attribute (usable Z with
   *  the readiness factor divided out). Effective skills depend only on raw
   *  skills, natural position and deployed role — none of which change while a
   *  player is on the pitch — so fatigue only rescales these. Caching them
   *  turns the per-step readiness refresh into eight multiplications instead of
   *  a fresh adjusted-skill set plus eight robust-Z evaluations per player. */
  baseZ: {
    tech: number;
    pace: number;
    physical: number;
    finishing: number;
    gk: number;
    defending: number;
    passing: number;
    playmaking: number;
  };
  /** Athleticism of the raw skill set (fatigue input); constant per player. */
  physical: number;
  onPitch: boolean;
}

export const ZONES: MatchZone[] = ["DEF_WIDE", "DEF_CENTRAL", "MID_WIDE", "MID_CENTRAL", "ATT_WIDE", "ATT_CENTRAL", "BOX"];
export const LANES: Lane[] = ["LEFT", "CENTRE", "RIGHT"];
export const INTENT_ACTIONS: IntentAction[] = ["PASS", "CROSS", "CARRY", "DRIBBLE", "SHOT", "CLEARANCE"];
export const FAILURE_ACTIONS: FailureAction[] = ["MISCONTROL", "DISPOSSESSED"];

const LONG_RANK: Record<MatchZone, number> = { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 1, MID_CENTRAL: 1, ATT_WIDE: 2, ATT_CENTRAL: 2, BOX: 3 };

// ---------------------------------------------------------------------------
// Canonical attributes (§5.3): one adapter; the engine never reads raw skill
// fields directly. `athleticism` is the runtime-only composite from §5.2.
// ---------------------------------------------------------------------------

export type CanonicalAttr = "goalkeeping" | "pace" | "technique" | "passing" | "defending" | "playmaking" | "athleticism" | "finishing";

export function athleticismOf(skills: { pace: number; des: number }): number {
  const w = (gameConfig as unknown as { playerPositions?: { athleticismWeights?: Record<string, number> } })?.playerPositions?.athleticismWeights;
  const paceW = w?.pace ?? 0.5;
  const desW = w?.des ?? 0.5;
  return skills.pace * paceW + skills.des * desW;
}

/** Canonical attribute value from a raw skill set. */
export function canonicalFromSkills(skills: LivePlayerState["skills"], attr: CanonicalAttr): number {
  switch (attr) {
    case "goalkeeping": return skills.gol;
    case "pace": return skills.pace;
    case "technique": return skills.tec;
    case "passing": return skills.pas;
    case "defending": return skills.des;
    case "playmaking": return skills.playmaking;
    case "athleticism": return athleticismOf(skills);
    case "finishing": return skills.fin;
  }
}

// §7 authority: outOfPosition.ts. The engine uses the ...OrFloor variant so a
// corrupt live slot map degrades to skill-1 rather than playing at full
// strength; selection code must use the null-returning variant instead.
export { rolePenalty } from "./outOfPosition";

/**
 * Effective raw skills after the role penalty (§7.1): clamp(raw - penalty, 1, 100),
 * applied exactly once to every consumed skill. Population centers remain based
 * on unpenalized raw skills.
 */
export function adjustedSkillsForRole(p: Player, role: DeployedRole): LivePlayerState["skills"] {
  return effectiveSkillsOrFloor(p.skills, p.position, role);
}

// ---------------------------------------------------------------------------
// Robust normalization (§7)
// ---------------------------------------------------------------------------

export interface AttributeCenters {
  median: Record<string, number>;
  sigma: Record<string, number>;
}

export function computeAttributeCenters(players: Player[]): AttributeCenters {
  const out: AttributeCenters = { median: {}, sigma: {} };
  const source: Record<CanonicalAttr, (p: Player) => number> = {
    goalkeeping: (p) => p.skills.gol,
    pace: (p) => p.skills.pace,
    technique: (p) => p.skills.tec,
    passing: (p) => p.skills.pas,
    defending: (p) => p.skills.des,
    playmaking: (p) => p.skills.playmaking,
    athleticism: (p) => athleticismOf(p.skills),
    finishing: (p) => p.skills.fin,
  };
  for (const key of Object.keys(source) as CanonicalAttr[]) {
    const values = players.map(source[key]).sort((a, b) => a - b);
    const n = values.length;
    const median = n === 0 ? 50 : n % 2 === 1 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
    const abs = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = abs.length === 0 ? 1 : abs.length % 2 === 1 ? abs[(abs.length - 1) / 2] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2;
    const robustSigma = Math.max(MS.normalization.madToSigma * mad, MS.normalization.minRobustSigma);
    out.median[key] = median;
    out.sigma[key] = robustSigma;
  }
  return out;
}

export function robustZ(value: number, median: number, sigma: number): number {
  const z = (value - median) / sigma;
  const c = MS.normalization.rawZClamp;
  return Math.max(-c, Math.min(c, z));
}

// ---------------------------------------------------------------------------
// Readiness (§8)
// ---------------------------------------------------------------------------

function readinessFactor(energy: number): number {
  return readiness(energy);
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function logit(p: number): number {
  const c = Math.max(1e-9, Math.min(1 - 1e-9, p));
  return Math.log(c / (1 - c));
}
function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Robustly standardize values (median/MAD), clamped to contestZClamp. */
export function robustStandardize(values: number[]): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const abs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = abs.length === 0 ? 1 : abs.length % 2 === 1 ? abs[(abs.length - 1) / 2] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2;
  const sigma = Math.max(mad * MS.normalization.madToSigma, 1e-6);
  const c = MS.normalization.contestZClamp;
  return values.map((v) => clamp((v - median) / sigma, -c, c));
}

/** Seeded weighted sampling (§26 etc.). */
export function weightedPick(rng: RngState, labels: string[], weights: number[]): string {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return labels[0];
  let roll = nextDouble(rng) * total;
  for (let i = 0; i < labels.length; i++) {
    roll -= Math.max(0, weights[i]);
    if (roll < 0) return labels[i];
  }
  return labels[labels.length - 1];
}

/** Involvement-weighted mean readiness; identical accumulation order to the
 *  `weightedMean(local.map(readiness), local.map(weight))` it replaces. */
function involvedReadinessMean(local: { ps: LivePlayerState; weight: number }[]): number {
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < local.length; i++) {
    sum += local[i].ps.readiness * local[i].weight;
    weightSum += local[i].weight;
  }
  return weightSum > 0 ? sum / weightSum : 0;
}

function weightedMean(values: number[], weights: number[]): number {
  let s = 0, ws = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i] * weights[i];
    ws += weights[i];
  }
  return ws > 0 ? s / ws : 0;
}

// ---------------------------------------------------------------------------
// Role mapping + formation geometry
// ---------------------------------------------------------------------------

/** Zone involvement weight for a player: their formation-support weight for the zone. */
function involvement(role: DeployedRole, zone: MatchZone): number {
  return MS.formationSupport[role]?.[zone] ?? 0;
}

/** Flattened `MS.formationSupport` rows: the same (zone, weight) pairs in the
 *  same order the config object enumerates them, materialized once so the
 *  per-step support/coverage rebuild does not call `Object.entries` twice per
 *  on-pitch player. */
const SUPPORT_KERNELS = new Map<string, { zone: MatchZone; weight: number }[]>();
function supportKernel(role: DeployedRole): { zone: MatchZone; weight: number }[] {
  let kernel = SUPPORT_KERNELS.get(role);
  if (!kernel) {
    kernel = Object.entries(MS.formationSupport[role] ?? {}).map(([zone, weight]) => ({ zone: zone as MatchZone, weight }));
    SUPPORT_KERNELS.set(role, kernel);
  }
  return kernel;
}

// ---------------------------------------------------------------------------
// Tactical adaptation
// ---------------------------------------------------------------------------

export function engineStyle(clubStyle: number): "CONTROL" | "PRESS" | "COUNTER" {
  if (clubStyle === 2) return "COUNTER";
  if (clubStyle === 1) return "PRESS";
  return "CONTROL";
}
export function engineDirection(direction: number): "CENTRE" | "WIDE" {
  return direction === 1 ? "WIDE" : "CENTRE";
}
export function enginePressing(pressing: number): number {
  // Club.tactics.pressing is a 0-2 scale (Light/Balanced/Heavy). Normalize to
  // [0,1] so press intensity is meaningful; `pressing.intensityDivisor` in
  // config targets a 0-100 scale that the club model does not use.
  return Math.max(0, Math.min(1, pressing / 2));
}

// ---------------------------------------------------------------------------
// Engine runtime
// ---------------------------------------------------------------------------

interface Side {
  idx: 0 | 1;
  club: Club;
  on: LivePlayerState[];
  bench: Player[];
  tactics: LiveTactics;
  // formation-support arrays per zone
  support: Record<MatchZone, number>;
  coverage: Record<MatchZone, number>;
  expectedSupport: Record<MatchZone, number>;
  expectedSupportTotal: number;
  organisation: number;
  baselineOrganisation: number;
  organisationDisruption: number;
  organisationRecoveryTime: number;
  /** Cached baseline organisation (recomputed when support/readiness change). */
  cachedBaselineOrganisation: number;
  /** Bumped whenever `on` gains/loses a player or a player's slot assignment
   *  changes (substitution, injury auto-sub); invalidates involvedCache below. */
  rosterVersion: number;
  /** Per-zone memo of involvedPlayers(side, zone): membership/weights depend
   *  only on deployed role + zone, not the per-step-changing readiness values on
   *  the same `ps` references, so it's safe to reuse until rosterVersion moves. */
  involvedCache: Partial<Record<MatchZone, { version: number; result: { ps: LivePlayerState; weight: number }[] }>>;
  /** The same memo projected to player ids, for the rating observer. */
  involvedIdCache: Partial<Record<MatchZone, { version: number; result: number[] }>>;
}

interface Engine {
  rng: RngState;
  st: LiveMatchState;
  home: Side;
  away: Side;
  /** Read-only rating observer (plan §17); no-op when absent. */
  ratingObserver?: RatingObserver;
  possessionSide: 0 | 1;
  phase: MatchPhase;
  zone: MatchZone;
  lane: Lane;
  possessionStartType: string;
  possessionAgeSeconds: number;
  pendingFirstAction: string | null;
  clockSeconds: number;
  period: 1 | 2;
  controlledSeconds: [number, number];
  attThirdSeconds: [number, number];
  stats: { home: TeamMatchStats; away: TeamMatchStats };
  cards: LiveCardState[];
  injuries: LiveInjuryState[];
  substitutions: LiveSubstitutionState[];
  events: MatchEvent[];
  isCounter: boolean;
  /** Client ball choreography: last resolved action and the zone it started
   *  from. Pure observations set each step; never consume RNG draws. */
  lastAction: string | null;
  prevZone: string | null;
  /** Stable visual carrier used only by the live pitch projection. */
  ballCarrierId: number | null;
  /** Assist bookkeeping: last completed PASS/CROSS passer of the possession.
   *  Presentation-level data only — never read before outcomes resolve, so it
   *  cannot alter the RNG stream or any probability. */
  lastPasserId: number | null;
  lastPasserSide: 0 | 1 | null;
  ballActionSequence: number;
  lastBallAction: LiveBallAction | null;
  possessionHighRecovery: boolean;
  opponentControlSeconds: [number, number];
  pressureAdvancedStates: [number, number];
  pressureWindowStart: [number, number];
  onPitchBySide: [Player[], Player[]];
  centers: AttributeCenters;
  homeOn: Player[];
  awayOn: Player[];
  playerMinutes: Record<number, number>;
  playerRecentLoad: Record<number, number>;
  playerMatchLoad: Record<number, number>;
  /** Per side, the last match-minute evaluated for AI tactical substitutions
   *  (mirrors st.aiSubLastMinute; -1 = never). Keeps once-per-minute cadence
   *  across chunked/streamed engine rebuilds. */
  aiSubLastMinute: [number, number];
  /** Scratch payload for `observeRatingSeconds`, keyed by roster version. */
  ratingSecondsRosterKey: string;
  ratingSecondsEntries: { playerId: number; seconds: number; fineRole: string }[];
  commentary: string[];
  ended: boolean;
  extraTimePlayed: boolean;
  shootout: { scores: [number, number]; winner: number } | null;
  playerYellows: Record<number, number>;
  scores: [number, number];
  deadBallSeconds: number;
  controlledOnlySeconds: number;
  actions: number;
  actionCounts: Record<string, number>;
  phaseResidenceSeconds: Record<MatchPhase, number>;
  restartCounts: Record<string, number>;
  possessionStarts: number;
  passIntentScale: number;
  tempoScale: number;
}

function sideOf(eng: Engine, side: 0 | 1): Side {
  return side === 0 ? eng.home : eng.away;
}
function opp(eng: Engine, side: 0 | 1): Side {
  return side === 0 ? eng.away : eng.home;
}

/** Read-only snapshot of the engine context for the rating observer (plan
 *  §5.2). Never mutates state and never consumes RNG. When `action` is given,
 *  the engine's actual action-quality / defensive-resistance aggregates for
 *  that action are captured so the observer's counterfactual re-derivation
 *  has the correct non-substituted baseline. */
function ratingContext(eng: Engine, action?: string): RatingDecisionInput {
  const sideView = (s: Side): RatingDecisionInput["sides"]["home"] => {
    const local = involvedPlayers(s, eng.zone);
    const readiness = local.length > 0 ? involvedReadinessMean(local) : 1;
    return {
      involved: local,
      localDensity: localDensity(s, eng.zone),
      supportRatio: (s.support[eng.zone] ?? 0) / Math.max(1e-6, s.expectedSupport[eng.zone] ?? 1),
      coverageRatio: (s.coverage[eng.zone] ?? 0) / Math.max(1e-6, s.expectedSupport[eng.zone] ?? 1),
      readinessMean: readiness,
      organisation: s.organisation,
      tactics: { style: s.tactics.style, pressing: s.tactics.pressing, direction: s.tactics.direction, familiarity: s.tactics.familiarity },
      gk: s.on.find((ps) => ps.deployedRole === "GK"),
      ...(action ? { actionQuality: actionQualityFor(s, eng.zone, action), defensiveResistance: defensiveResistanceFor(s, eng.zone, action) } : {}),
    };
  };
  return {
    phase: eng.phase,
    zone: eng.zone,
    possessionSide: eng.possessionSide,
    homeNeutral: eng.st.homeNeutral,
    stateValue: stateValue(eng),
    homeClubId: eng.home.club.id,
    awayClubId: eng.away.club.id,
    possessionThreat: possessionThreat(eng),
    sides: { home: sideView(eng.home), away: sideView(eng.away) },
  };
}

/** Emit a decision observation to the engine's rating observer (no-op when
 *  absent). `probabilities` carries the engine's actual normalized vector. */
function emitDecision(
  eng: Engine,
  kind: "control-failure" | "intent" | "outcome" | "next-zone" | "shot" | "cards",
  probabilities: Record<string, number | string>,
  resolved: string,
  participants: number[],
): void {
  const action = kind === "outcome" || kind === "intent" || kind === "next-zone" ? (typeof probabilities.action === "string" ? probabilities.action : undefined) : undefined;
  eng.ratingObserver?.onDecision(kind, ratingContext(eng, action), probabilities, resolved, participants);
}

/** Credit both sides' on-pitch players with `seconds` of rating time (plan
 *  §12: rating minutes = on-pitch match time, including dead-ball restarts so
 *  a full-match player accumulates the full match clock). Read-only. */
function observeRatingSeconds(eng: Engine, seconds: number): void {
  if (!eng.ratingObserver) return;
  // The payload's shape (which ids, in which role) only changes when a side's
  // roster does, but the hook fires once per resolved action. Reuse one
  // scratch payload -- the observer consumes it synchronously -- and rebuild it
  // only when a substitution or dismissal moves a roster version.
  const rosterKey = `${eng.home.rosterVersion}:${eng.away.rosterVersion}`;
  if (eng.ratingSecondsRosterKey !== rosterKey) {
    const entries: { playerId: number; seconds: number; fineRole: string }[] = [];
    for (const side of [eng.home, eng.away]) {
      for (const ps of side.on) entries.push({ playerId: ps.id, seconds, fineRole: ps.deployedRole });
    }
    eng.ratingSecondsEntries = entries;
    eng.ratingSecondsRosterKey = rosterKey;
  }
  for (const entry of eng.ratingSecondsEntries) entry.seconds = seconds;
  eng.ratingObserver.onSeconds(eng.ratingSecondsEntries);
}

function phaseForZone(zone: MatchZone): MatchPhase {
  if (zone === "DEF_WIDE" || zone === "DEF_CENTRAL") return "BUILD_UP";
  if (zone === "MID_WIDE" || zone === "MID_CENTRAL") return "PROGRESSION";
  return "FINAL_THIRD";
}

function mirrorLane(lane: Lane): Lane {
  return lane === "CENTRE" ? "CENTRE" : lane === "LEFT" ? "RIGHT" : "LEFT";
}

function zoneToLane(zone: MatchZone): Lane {
  if (zone === "BOX") return "CENTRE";
  return zone.endsWith("WIDE") ? "RIGHT" : "CENTRE";
}

/** Map an abstract destination zone (DEF/MID/ATT) + lane to a concrete zone. */
function zoneLane(zone: MatchZone, lane: Lane): MatchZone {
  if (zone === "BOX") return "BOX";
  if (zone === "DEF_WIDE" || zone === "DEF_CENTRAL") {
    return lane === "CENTRE" ? "DEF_CENTRAL" : "DEF_WIDE";
  }
  if (zone === "MID_WIDE" || zone === "MID_CENTRAL") {
    return lane === "CENTRE" ? "MID_CENTRAL" : "MID_WIDE";
  }
  return lane === "CENTRE" ? "ATT_CENTRAL" : "ATT_WIDE";
}

// ---------------------------------------------------------------------------
// Player-side setup
// ---------------------------------------------------------------------------

/**
 * Resolve a player's deployed role from the side's current formation plus his
 * live slot index (§8/§9.1). Never inspects natural position for zone support.
 *
 * Returns `null` for a missing or out-of-range slot. §15.1 requires corrupt live
 * state to be rejected, not defaulted: the previous `ST` fallback silently
 * fielded an unmapped player as a striker (the out-of-position penalty for
 * outfielder→ST is finite, so nothing downstream noticed).
 */
export function tryDeployedRoleForSlot(
  slotMap: Record<number, number> | undefined,
  formationId: number,
  playerId: number,
): { role: DeployedRole; slotIndex: number } | null {
  const slotIndex = slotMap?.[playerId];
  if (slotIndex === undefined) return null;
  const slot = formationById(formationId)?.slots[slotIndex];
  if (!slot) return null;
  return { role: slot.role, slotIndex };
}

/**
 * Strict form of {@link tryDeployedRoleForSlot} for engine paths that have
 * already established the player is on the pitch. Throws on corrupt state so a
 * broken slot map surfaces as a match error instead of a silent role swap.
 */
export function deployedRoleForSlot(
  slotMap: Record<number, number> | undefined,
  formationId: number,
  playerId: number,
): { role: DeployedRole; slotIndex: number } {
  const resolved = tryDeployedRoleForSlot(slotMap, formationId, playerId);
  if (!resolved) {
    const raw = slotMap?.[playerId];
    throw new Error(
      `Corrupt live slot map: player ${playerId} maps to slot ${raw ?? "<missing>"} in formation ${formationId}`,
    );
  }
  return resolved;
}

function buildPlayerState(p: Player, centers: AttributeCenters, role: DeployedRole, slotIndex: number, energy = p.energy): LivePlayerState {
  const readiness = readinessFactor(energy);
  // §7.1: effective raw skill = clamp(raw - rolePenalty, 1, 100), applied
  // exactly once; usableZ = robustZ(effectiveRaw) * readiness (no fit factor).
  const effective = adjustedSkillsForRole(p, role);
  const z = (attr: CanonicalAttr, value: number) => robustZ(value, centers.median[attr], centers.sigma[attr]);
  // §5.3: eight distinct canonical attributes; passing/playmaking each have
  // their own median/sigma and stored Z, not an average of tech/pace.
  const baseZ = {
    tech: z("technique", effective.tec),
    pace: z("pace", effective.pace),
    physical: z("athleticism", athleticismOf(effective)),
    finishing: z("finishing", effective.fin),
    gk: z("goalkeeping", effective.gol),
    defending: z("defending", effective.des),
    passing: z("passing", effective.pas),
    playmaking: z("playmaking", effective.playmaking),
  };
  return {
    id: p.id,
    skills: { ...p.skills },
    overall: p.overall,
    age: p.age,
    position: p.position as NaturalPosition,
    deployedRole: role,
    slotIndex,
    energy,
    readiness,
    zTech: baseZ.tech * readiness,
    zPace: baseZ.pace * readiness,
    zPhysical: baseZ.physical * readiness,
    zFinishing: baseZ.finishing * readiness,
    zGk: baseZ.gk * readiness,
    zDefending: baseZ.defending * readiness,
    zPassing: baseZ.passing * readiness,
    zPlaymaking: baseZ.playmaking * readiness,
    baseZ,
    physical: physicalSkill(p),
    onPitch: true,
  };
}

function refreshReadiness(ps: LivePlayerState): void {
  const r = readinessFactor(ps.energy);
  const b = ps.baseZ;
  ps.readiness = r;
  ps.zTech = b.tech * r;
  ps.zPace = b.pace * r;
  ps.zPhysical = b.physical * r;
  ps.zFinishing = b.finishing * r;
  ps.zGk = b.gk * r;
  ps.zDefending = b.defending * r;
  ps.zPassing = b.passing * r;
  ps.zPlaymaking = b.playmaking * r;
}

function playerUsableZ(ps: LivePlayerState, attr: CanonicalAttr): number {
  switch (attr) {
    case "technique": return ps.zTech;
    case "pace": return ps.zPace;
    case "athleticism": return ps.zPhysical;
    case "finishing": return ps.zFinishing;
    case "goalkeeping": return ps.zGk;
    case "defending": return ps.zDefending;
    case "passing": return ps.zPassing;
    case "playmaking": return ps.zPlaymaking;
  }
}

/** Local involved players in the current zone: those with support weight > 0. */
function involvedPlayers(side: Side, zone: MatchZone): { ps: LivePlayerState; weight: number }[] {
  const cached = side.involvedCache[zone];
  if (cached && cached.version === side.rosterVersion) return cached.result;
  const out: { ps: LivePlayerState; weight: number }[] = [];
  for (const ps of side.on) {
    const w = involvement(ps.deployedRole, zone);
    if (w > 0) out.push({ ps, weight: w });
  }
  side.involvedCache[zone] = { version: side.rosterVersion, result: out };
  return out;
}

/** Ids of the zone-involved players, memoized on the same roster version as
 *  `involvedPlayers`. Only the rating observer consumes them. */
function involvedIds(side: Side, zone: MatchZone): number[] {
  const cached = side.involvedIdCache[zone];
  if (cached && cached.version === side.rosterVersion) return cached.result;
  const result = involvedPlayers(side, zone).map((l) => l.ps.id);
  side.involvedIdCache[zone] = { version: side.rosterVersion, result };
  return result;
}

/**
 * Selects a stable visual participant without touching the match RNG stream.
 * The simulator intentionally models possession at team/zone level; this
 * deterministic attribution gives the pitch a real jersey to animate while
 * keeping the simulation's probability model unchanged.
 */
function presentationPlayerId(side: Side, zone: MatchZone, excludeId: number | null = null, allowGoalkeeper = false): number | null {
  const local = involvedPlayers(side, zone)
    .filter(({ ps }) => allowGoalkeeper || ps.deployedRole !== "GK")
    .sort((a, b) => b.weight - a.weight || (a.ps.slotIndex - b.ps.slotIndex) || a.ps.id - b.ps.id);
  const pool = local.length > 0
    ? local
    : side.on
      .filter((ps) => allowGoalkeeper || ps.deployedRole !== "GK")
      .sort((a, b) => a.slotIndex - b.slotIndex || a.id - b.id)
      .map((ps) => ({ ps, weight: 0 }));
  const chosen = pool.find(({ ps }) => ps.id !== excludeId) ?? pool[0];
  return chosen?.ps.id ?? null;
}

/** Structural zone projection for a failed pass/cross; no probability draw. */
function presentationIntentZone(zone: MatchZone, action: string): MatchZone {
  const forward = action === "PASS" || action === "CROSS" || action === "CARRY" || action === "DRIBBLE";
  const wide = zone.endsWith("WIDE");
  const ladder = wide ? ["DEF_WIDE", "MID_WIDE", "ATT_WIDE", "BOX"] : ["DEF_CENTRAL", "MID_CENTRAL", "ATT_CENTRAL", "BOX"];
  const index = ladder.indexOf(zone);
  if (index < 0) return zone;
  const next = forward ? Math.min(ladder.length - 1, index + 1) : Math.max(0, index - 1);
  return ladder[next] as MatchZone;
}

/** Local support relative to the eleven-player formation reference. */
function localDensity(side: Side, zone: MatchZone): number {
  const expected = side.expectedSupport[zone] ?? 0;
  if (expected <= 0) return 1;
  return clamp((side.support[zone] ?? 0) / expected, 0, 1);
}

/** Weighted mean usable attribute over local involvement (§9 ball security). */
function localQuality(side: Side, zone: MatchZone, attr: CanonicalAttr): number {
  const local = involvedPlayers(side, zone);
  if (local.length === 0) return 0;
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < local.length; i++) {
    sum += playerUsableZ(local[i].ps, attr) * local[i].weight;
    weightSum += local[i].weight;
  }
  return weightSum > 0 ? sum / weightSum : 0;
}

/** Flattened attribute-weight rows, materialized once per action so the
 *  per-step aggregates do not call `Object.entries` on config objects. The
 *  arrays preserve the config's own key order, so the accumulation sequence —
 *  and therefore every floating-point result — is unchanged. */
type AttributeWeightRow = { attr: CanonicalAttr; weight: number }[];
const ATTRIBUTE_WEIGHT_ROWS = new Map<string, AttributeWeightRow | null>();
const RESISTANCE_WEIGHT_ROWS = new Map<string, AttributeWeightRow | null>();
function weightRow(cache: Map<string, AttributeWeightRow | null>, table: Record<string, Record<string, number>>, action: string): AttributeWeightRow | null {
  let row = cache.get(action);
  if (row === undefined) {
    const source = table[action];
    row = source ? Object.entries(source).map(([attr, weight]) => ({ attr: attr as CanonicalAttr, weight })) : null;
    cache.set(action, row);
  }
  return row;
}

/** Shared body of the two §11 aggregates: Σ_attr w_attr · weightedMean(usableZ)
 *  scaled by local density. The involvement weights are the same for every
 *  attribute, so their sum is accumulated once instead of per attribute. */
function weightedAttributeAggregate(side: Side, zone: MatchZone, row: AttributeWeightRow): number {
  const local = involvedPlayers(side, zone);
  if (local.length === 0) return 0;
  let weightSum = 0;
  for (let i = 0; i < local.length; i++) weightSum += local[i].weight;
  let sum = 0;
  for (let a = 0; a < row.length; a++) {
    const attr = row[a].attr;
    let acc = 0;
    for (let i = 0; i < local.length; i++) acc += playerUsableZ(local[i].ps, attr) * local[i].weight;
    sum += row[a].weight * (weightSum > 0 ? acc / weightSum : 0);
  }
  // A weighted mean alone hides a missing player when the remaining players
  // are near-average. Local density keeps the effect zone-specific: losing a
  // player reduces execution in the zones that player normally supports.
  return sum * localDensity(side, zone);
}

/** Team action quality (§11): weighted mean of usable attribute Z across local involvement. */
function actionQualityFor(side: Side, zone: MatchZone, action: string): number {
  const row = weightRow(ATTRIBUTE_WEIGHT_ROWS, MS.actionQuality.attributeWeights, action);
  if (!row) return 0;
  return weightedAttributeAggregate(side, zone, row);
}

function defensiveResistanceFor(side: Side, zone: MatchZone, action: string): number {
  const row = weightRow(RESISTANCE_WEIGHT_ROWS, MS.actionQuality.defensiveResistanceWeights, action);
  if (!row) return 0;
  return weightedAttributeAggregate(side, zone, row);
}

// ---------------------------------------------------------------------------
// Formation support / coverage (§15)
// ---------------------------------------------------------------------------

function computeSupport(side: Side): void {
  // Called twice per possession step; mutate the side's existing support/
  // coverage records in place instead of allocating two fresh ones each time.
  for (const zone of ZONES) {
    side.support[zone] = 0;
    side.coverage[zone] = 0;
  }
  for (const ps of side.on) {
    const kernel = supportKernel(ps.deployedRole);
    const coverageFactor = 0.55 + 0.45 * ps.readiness;
    for (let i = 0; i < kernel.length; i++) {
      const { zone, weight } = kernel[i];
      side.support[zone] += weight;
      side.coverage[zone] += weight * coverageFactor;
    }
  }
  // A dismissal/injury reduces the side's available support, but the raw
  // deficit would assume an instant, perfectly uncoordinated collapse. Keep
  // the empirical effect configurable while retaining the actual readiness
  // gap (and the separate capped workload pathway) for the remaining players.
  const cfg = MS.numericalDisadvantage;
  if (side.on.length < cfg.referencePlayers) {
    const scale = cfg.formationLossEffectScale;
    for (const zone of ZONES) {
      const expected = side.expectedSupport[zone] ?? 0;
      if (expected <= 0) continue;
      const rawSupport = side.support[zone];
      const rawCoverage = side.coverage[zone];
      side.support[zone] = expected + (rawSupport - expected) * scale;
      side.coverage[zone] = side.support[zone] + (rawCoverage - rawSupport);
    }
  }
  side.cachedBaselineOrganisation = baselineOrganisation(side);
}

function expectedSupport(formation: number): Record<MatchZone, number> {
  const out: Record<MatchZone, number> = { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 };
  // §4.1/§8: the formation catalog is the single authority; expectedSupport
  // reads the same kernels as live support. No duplicate formation array.
  const def = formationById(formation) ?? formationById(4);
  if (!def) return out;
  for (const slot of def.slots) {
    for (const { zone, weight } of supportKernel(slot.role)) out[zone] += weight;
  }
  return out;
}

function shapeSignal(eng: Engine, zone: MatchZone): number {
  const att = eng.possessionSide;
  const side = sideOf(eng, att);
  const def = opp(eng, att);
  const own = (side.support[zone] ?? 0) / Math.max(1e-6, side.expectedSupport[zone] ?? 1);
  const oppCov = (def.coverage[zone] ?? 0) / Math.max(1e-6, def.expectedSupport[zone] ?? 1);
  const raw = own - oppCov;
  return clamp(raw / Math.SQRT2, -MS.normalization.contestZClamp, MS.normalization.contestZClamp);
}

// ---------------------------------------------------------------------------
// Pressing (§18)
// ---------------------------------------------------------------------------

function pressSignalAtExecution(side: Side, zone: MatchZone, executionFactor: number): number {
  const intensity = side.tactics.pressing;
  if (intensity <= 0) return 0;
  const localSupport = (side.support[zone] ?? 0) / Math.max(1e-6, side.expectedSupport[zone] ?? 1);
  const local = involvedPlayers(side, zone);
  const readinessMean = local.length > 0 ? involvedReadinessMean(local) : 1;
  const raw = intensity * localSupport * executionFactor * readinessMean;
  // Standardize against the neutral reference (raw ≈ 1 at moderate press).
  const z = (raw - 0.6) / 0.5;
  return clamp(z, -MS.normalization.contestZClamp, MS.normalization.contestZClamp);
}

function pressSignal(eng: Engine, side: Side, zone: MatchZone): number {
  const opponent = side === eng.home ? eng.away : eng.home;
  return pressSignalAtExecution(side, zone, tacticalExecutionContrast(side.tactics.familiarity, opponent.tactics.familiarity));
}

// ---------------------------------------------------------------------------
// Direction (§16)
// ---------------------------------------------------------------------------

function laneScore(tactics: LiveTactics, lane: Lane): number {
  if (tactics.direction === "WIDE") {
    return lane === "CENTRE" ? 0 : 1;
  }
  // CENTRE preference
  return lane === "CENTRE" ? 1 : 0;
}

/** Destination lane preference (used for next-zone lane selection).
 *  `laneScore` reads nothing but the side's direction, so the standardized
 *  triple has exactly two possible values; both are derived once. */
const DIRECTION_SIGNALS = new Map<string, number[]>();
function directionSignal(eng: Engine, candidateLane: Lane): number {
  const side = sideOf(eng, eng.possessionSide);
  const direction = side.tactics.direction;
  let standardized = DIRECTION_SIGNALS.get(direction);
  if (!standardized) {
    standardized = robustStandardize(LANES.map((l) => laneScore(side.tactics, l)));
    DIRECTION_SIGNALS.set(direction, standardized);
  }
  return standardized[LANES.indexOf(candidateLane)];
}

// ---------------------------------------------------------------------------
// Tactical component combination (§19)
// ---------------------------------------------------------------------------

/** Combine active tactical components (each already centered) into Z_tactics. */
function combineTactics(eng: Engine, components: number[]): number {
  const active = components.filter((c) => Number.isFinite(c));
  if (active.length === 0) return 0;
  const raw = active.reduce((s, c) => s + c, 0) / Math.sqrt(active.length);
  const sigma = Math.max(robustTacticalSigma(eng), MS.normalization.minTacticalSigma);
  return clamp(raw / sigma, -MS.normalization.contestZClamp, MS.normalization.contestZClamp);
}

// The normalization reference is pinned to the live-match state so a streamed
// match uses the same tactical scale as an instant simulation. Recomputing it
// after every worker chunk would make the RNG/action path chunk-dependent as
// fatigue and cards alter support during play.
const tacticalSigmaCache = new WeakMap<object, number>();
function robustTacticalSigma(eng: Engine): number {
  const key = eng.st;
  const cached = tacticalSigmaCache.get(key);
  if (cached !== undefined) return cached;
  // Compute a representative sigma at the fixed starting-familiarity reference.
  // Letting actual familiarity alter the denominator would partially normalize
  // away the proportional execution effect that calibration needs to measure.
  const samples: number[] = [];
  const referenceExecution = tacticalExecution(INITIAL_FAMILIARITY);
  for (const zone of ZONES) {
    samples.push(shapeSignal(eng, zone));
    samples.push(pressSignalAtExecution(sideOf(eng, eng.possessionSide), zone, referenceExecution));
    samples.push(pressSignalAtExecution(opp(eng, eng.possessionSide), zone, referenceExecution));
    samples.push(directionSignal(eng, "LEFT"));
    samples.push(directionSignal(eng, "CENTRE"));
    samples.push(directionSignal(eng, "RIGHT"));
  }
  const sigma = standardDeviation(samples);
  tacticalSigmaCache.set(key, sigma || 1);
  return sigma || 1;
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

// ---------------------------------------------------------------------------
// 40/35/25 choice (§6) — log-linear choice model
// ---------------------------------------------------------------------------
//
// The plan's neutral-distribution validation (§47) requires the simulated
// intent/outcome/transition distribution to reproduce the configured empirical
// baseline in neutral (equal-team) conditions. The §6 softmax written as
// exp(U_i / luckScale) with luckScale = sqrt(3·wLuck)/π ≈ 0.276 concentrates
// the choice so heavily that the configured retention-dominated tables would
// never advance possessions (producing ~0 shots instead of ~25/match).
//
// The equivalent log-linear formulation uses temperature 1:
//     P(i) ∝ exp(U_i) = P0_i · exp(teamScale·Z_team_i + tacticsScale·Z_tactics_i
//                                    + contextUtility_i)
// so neutral conditions reproduce P0 exactly, while team/tactics signals shift
// the choice and `luckScale` remains the documented luck-variance constant. The
// seeded Gumbel argmax representation is therefore not used; a cumulative
// weighted draw over the exponentiated weights is deterministic and equivalent.

function choiceWeights(utilities: number[]): number[] {
  // U_i already = log(P0_i) + signals; exp gives P0_i · exp(signals).
  return utilities.map((u) => Math.exp(Math.max(-50, Math.min(50, u))));
}

/** Build the latent utility for an option: log(P0) + 40/35/25 signals. */
function utility(
  _eng: Engine,
  baseLogP: number,
  zTeam: number,
  zTactics: number,
  contextUtility: number
): number {
  const { teamScale, tacticsScale } = INFLUENCE_SCALES;
  return baseLogP + teamScale * zTeam + tacticsScale * zTactics + contextUtility;
}

/** Pick an option by cumulative weighted draw (deterministic, seeded). */
function choice(rng: RngState, labels: string[], utilities: number[]): string {
  const weights = choiceWeights(utilities);
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return labels[0];
  let roll = nextDouble(rng) * total;
  for (let i = 0; i < labels.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return labels[i];
  }
  return labels[labels.length - 1];
}

// ---------------------------------------------------------------------------
// Timing (§20/§21)
// ---------------------------------------------------------------------------

function gammaParams(action: string, phase: MatchPhase, zone: MatchZone): { shape: number; scale: number } | null {
  const table = MS.timing.durationGamma;
  const zKey = `${action}.${phase}.${zone}`;
  const zoneRow = table.ACTION_PHASE_ZONE[zKey];
  if (zoneRow) return zoneRow;
  const pKey = `${action}.${phase}`;
  const phaseRow = table.ACTION_PHASE[pKey];
  if (phaseRow) return phaseRow;
  const actionRow = table.ACTION[action];
  if (actionRow) return actionRow;
  return null;
}

function qualityCompensation(players: Player[], clubIds: Set<number>, initialXIIds: number[]): { passIntentScale: number; tempoScale: number } {
  const cfg = MS.normalization.qualityCompensation;
  const byId = playerIndexFor(players);
  const initialXI = initialXIIds.map((id) => byId.get(id)).filter((player): player is Player => Boolean(player));
  // The two-club roster scan is only the fallback for an empty initial XI, so
  // it stays behind that branch instead of running on every engine build.
  const rosterMean = (): number | null => {
    let sum = 0;
    let count = 0;
    for (const player of players) {
      if (player.clubId === null || !clubIds.has(player.clubId)) continue;
      sum += player.overall ?? 0;
      count++;
    }
    return count > 0 ? sum / count : null;
  };
  const referenceOverall = initialXI.length > 0
    ? initialXI.reduce((sum, player) => sum + (player.overall ?? 0), 0) / initialXI.length
    : rosterMean() ?? cfg.referenceOverall;
  const fraction = clamp((referenceOverall - cfg.referenceOverall) / Math.max(1, cfg.highOverall - cfg.referenceOverall), 0, 1);
  return {
    passIntentScale: MS.tacticalActionMix.passIntentScale + fraction * (cfg.highQualityPassIntentScale - MS.tacticalActionMix.passIntentScale),
    tempoScale: MS.timing.tempoScale + fraction * (cfg.highQualityTempoScale - MS.timing.tempoScale),
  };
}

function controlledDuration(eng: Engine, action: string, phase: MatchPhase, zone: MatchZone): number {
  const params = gammaParams(action, phase, zone);
  if (params) {
    const sample = gamma(eng.rng, params.shape) * params.scale;
    return sample / eng.tempoScale;
  }
  return MS.timing.instantActionSeconds / eng.tempoScale;
}

// ---------------------------------------------------------------------------
// State row lookup
// ---------------------------------------------------------------------------

function stateKey(phase: MatchPhase, zone: MatchZone): string {
  return `${phase}.${zone}`;
}

function intentBaseline(eng: Engine): Record<string, number> {
  const row = MS.probabilityModel.state[stateKey(eng.phase, eng.zone)];
  if (!row) return {};
  const baseline = { ...row.intentProbabilities };
  if (baseline.PASS !== undefined) baseline.PASS *= eng.passIntentScale;
  return baseline;
}

function failureBaseline(eng: Engine): { controlFailureProbability: number; miscontrol: number; dispossessed: number } {
  const row = MS.probabilityModel.state[stateKey(eng.phase, eng.zone)];
  const cf = row?.controlFailureProbability ?? 0.01;
  const mis = row?.controlFailureTypeProbabilities?.MISCONTROL ?? 0.5;
  return { controlFailureProbability: cf, miscontrol: mis, dispossessed: 1 - mis };
}

function outcomeBaseline(eng: Engine, action: string): { continue: number; turnover: number; foul: number; retainedRestart: number } {
  const row = MS.probabilityModel.outcomeByStateAction[`${stateKey(eng.phase, eng.zone)}.${action}`];
  if (!row) return { continue: 0.9, turnover: 0.05, foul: 0.03, retainedRestart: 0.02 };
  const mult = MS.probabilityModel.foulProbabilityCalibrationMultiplier;
  const foul = row.foul * mult;
  const rest = row.continue + row.turnover + foul + row.retainedRestart;
  return {
    continue: row.continue / rest,
    turnover: row.turnover / rest,
    foul: foul / rest,
    retainedRestart: row.retainedRestart / rest,
  };
}

const EMPTY_BASELINE: Readonly<Record<string, number>> = Object.freeze({});
/** Read-only view of the configured next-zone row. Callers only read it, and
 *  `pickNextZone` asks for the same row once per candidate destination, so the
 *  defensive copy this used to return was pure per-step garbage. */
function nextZoneBaseline(eng: Engine, action: string): Record<string, number> {
  const row = MS.probabilityModel.nextZoneByStateAction[`${stateKey(eng.phase, eng.zone)}.${action}`];
  return row ?? EMPTY_BASELINE;
}

// ---------------------------------------------------------------------------
// Control failure (§9)
// ---------------------------------------------------------------------------

function controlFailureStep(eng: Engine): FailureAction | null {
  const att = eng.possessionSide;
  const def = opp(eng, att);
  const { controlFailureProbability, miscontrol, dispossessed } = failureBaseline(eng);
  const zBallSecurity = localQuality(sideOf(eng, att), eng.zone, "technique");
  const zOppPress = pressSignal(eng, def, eng.zone);
  const logitP = logit(controlFailureProbability) - INFLUENCE_SCALES.teamScale * zBallSecurity + INFLUENCE_SCALES.tacticsScale * zOppPress;
  const pFail = logistic(logitP);
  const failed = nextDouble(eng.rng) < pFail;
  let failure: FailureAction | null = null;
  if (failed) {
    const misU = Math.log(miscontrol);
    const dispU = Math.log(dispossessed);
    failure = choice(eng.rng, ["MISCONTROL", "DISPOSSESSED"], [misU, dispU]) as FailureAction;
  }
  if (eng.ratingObserver) {
    emitDecision(eng, "control-failure", { FAIL: pFail, KEEP: 1 - pFail }, failed ? "FAIL" : "KEEP", involvedIds(sideOf(eng, att), eng.zone));
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Intentional action selection (§10)
// ---------------------------------------------------------------------------

function contextUtility(eng: Engine, action: string): number {
  let cu = 0;
  // Home advantage creation redistribution (§29): shift attacking
  // progression/chance-intent utility between home and away in advanced zones.
  const homeNeutral = eng.st.homeNeutral;
  if (!homeNeutral) {
    const rank = LONG_RANK[eng.zone];
    if (rank >= 1 && (action === "PASS" || action === "CARRY" || action === "CROSS" || action === "DRIBBLE")) {
      cu += Math.log(creationMultiplier(eng));
    }
  }
  // Pressing CONTINUE penalty / TURNOVER bonus applied in outcome step instead.
  return cu;
}

let _creationMultiplier: [number | null, number | null] = [null, null];
function creationMultiplier(eng: Engine): number {
  const side = eng.possessionSide;
  if (_creationMultiplier[side] !== null) return _creationMultiplier[side] as number;
  const baseTeamXg = MS.validation.reference["TEAM_MATCH.xG"]?.mean ?? 1.28;
  const signedAdvantage = side === 0 ? MS.homeAdvantage.targetXg : -MS.homeAdvantage.targetXg;
  const m = Math.max(0.05, 1 + MS.homeAdvantage.creationShare * (signedAdvantage / baseTeamXg));
  _creationMultiplier[side] = m;
  return m;
}

function selectIntentionalAction(eng: Engine): string {
  const baselines = intentBaseline(eng);
  const labels = Object.keys(baselines).filter((a) => (baselines[a] ?? 0) > 0);
  if (labels.length === 0) return "PASS";
  const att = eng.possessionSide;
  const utilities = labels.map((action) => {
    const p0 = baselines[action] ?? 0;
    const baseLogP = Math.log(Math.max(1e-9, p0));
    const zTeam = actionQualityFor(sideOf(eng, att), eng.zone, action) - defensiveResistanceFor(opp(eng, att), eng.zone, action);
    const zTactics = tacticalSignalForAction(eng, action);
    const cu = contextUtility(eng, action) + asymmetricActionUtility(eng, action);
    return utility(eng, baseLogP, zTeam, zTactics, cu);
  });
  const chosen = choice(eng.rng, labels, utilities) as string;
  // The normalized vector is observer-only reporting; re-exponentiating every
  // utility is wasted work when nothing is listening.
  if (eng.ratingObserver) {
    const weights = utilities.map((u) => Math.exp(Math.max(-50, Math.min(50, u))));
    const total = weights.reduce((s, w) => s + w, 0) || 1;
    const probs: Record<string, number | string> = {};
    labels.forEach((l, i) => { probs[l] = weights[i] / total; });
    emitDecision(eng, "intent", probs, chosen, involvedIds(sideOf(eng, att), eng.zone));
  }
  return chosen;
}

/** §14 CONTROL risk scores for a (phase, zone) state: the legal non-shot
 *  actions and their robust-standardized turnover logits. Config-only, so the
 *  memo is valid for the process lifetime. */
const CONTROL_RISK_SCORES = new Map<string, { legal: string[]; standardized: number[] }>();
function controlRiskScores(eng: Engine): { legal: string[]; standardized: number[] } {
  const key = stateKey(eng.phase, eng.zone);
  let cached = CONTROL_RISK_SCORES.get(key);
  if (!cached) {
    const legal = Object.keys(intentBaseline(eng)).filter((a) => a !== "SHOT");
    cached = { legal, standardized: robustStandardize(legal.map((a) => logit(outcomeBaseline(eng, a).turnover + 1e-9))) };
    CONTROL_RISK_SCORES.set(key, cached);
  }
  return cached;
}

/** Centered action-mix correction outside the neutral CONTROL/CONTROL matchup. */
function asymmetricActionUtility(eng: Engine, action: string): number {
  const side = sideOf(eng, eng.possessionSide);
  const opposingStyle = opp(eng, eng.possessionSide).tactics.style;
  if (side.tactics.style === "CONTROL" && opposingStyle === "CONTROL") return 0;
  const scale = MS.tacticalActionMix.nonNeutralCorrectionScale;
  return scale * (MS.tacticalActionMix.asymmetricActionUtility[action] ?? 0);
}

/** Style/shape tactical signal for an action intent (§14/§17/§19).
 * Familiarity scales only style execution. Adding the same
 * familiarity constant to every candidate would cancel out in the softmax. */
function tacticalSignalForAction(eng: Engine, action: string): number {
  const side = sideOf(eng, eng.possessionSide);
  const style = side.tactics.style;
  const opponent = opp(eng, eng.possessionSide);
  const executionFactor = tacticalExecutionContrast(side.tactics.familiarity, opponent.tactics.familiarity);
  const components: number[] = [];
  // Shape
  components.push(shapeSignal(eng, eng.zone));
  if (style === "CONTROL") {
    // riskScore(action) = robust standardized logit(TURNOVER | state, action).
    // The whole table depends only on (phase, zone) — never on the candidate
    // action or on either side — so it is derived once per state instead of
    // being rebuilt (two sorts plus a baseline object per legal action) for
    // every candidate of every intent draw.
    const risk = controlRiskScores(eng);
    const idx = risk.legal.indexOf(action);
    if (idx >= 0) {
      const styleSignal = -risk.standardized[idx];
      components.push(styleSignal * executionFactor);
    }
  } else if (style === "COUNTER") {
    if (eng.phase === "TRANSITION") {
      const expected = Math.max(expectedActionSeconds(action), MS.timing.instantActionSeconds);
      const speed = Math.max(LONG_RANK[eng.zone] / 3, 0) / expected;
      components.push(speed * executionFactor);
    }
    // else styleRaw = 0
  }
  const signal = combineTactics(eng, components);
  // Same-style matches, including the neutral baseline, remain on the
  // established path; action-mix corrections are applied separately above.
  return signal;
}

function expectedActionSeconds(action: string): number {
  const params = gammaParams(action, "TRANSITION", _placeholderZone);
  if (!params) return MS.timing.instantActionSeconds;
  return params.shape * params.scale;
}
let _placeholderZone: MatchZone = "MID_CENTRAL";

// ---------------------------------------------------------------------------
// Outcomes (§12)
// ---------------------------------------------------------------------------

/** §5.6 defendingControl: shared config-backed discipline-risk normalization.
 *  Higher defending must never increase foul/card probability. */
function defendingRisk(zDefending: number): number {
  const cfg = (MS as unknown as { defendingControl?: { riskMidpoint: number; zRiskScale: number } })?.defendingControl;
  const midpoint = cfg?.riskMidpoint ?? 0.5;
  const scale = cfg?.zRiskScale ?? 0.08;
  return clamp(midpoint - scale * zDefending, 0, 1);
}

function foulContextShift(eng: Engine, defSide: Side): number {
  const local = involvedPlayers(defSide, eng.zone);
  const localReadiness = local.length > 0 ? involvedReadinessMean(local) : 1;
  // Discipline risk from the zone-level defending Z (§5.6).
  const defendingZ = localQuality(defSide, eng.zone, "defending");
  const disciplineRisk = defendingRisk(defendingZ);
  const fatigueRisk = 1 - localReadiness;
  const lowOrganisation = 1 - defSide.organisation;
  const pressIntensity = defSide.tactics.pressing;
  return (
    MS.fouls.disciplineRiskLogitCoefficient * disciplineRisk +
    MS.fouls.pressIntensityLogitCoefficient * pressIntensity +
    MS.fouls.fatigueLogitCoefficient * fatigueRisk +
    MS.fouls.lowOrganisationLogitCoefficient * lowOrganisation
  );
}

function resolveOutcome(eng: Engine, action: string): Outcome {
  const base = outcomeBaseline(eng, action);
  const att = eng.possessionSide;
  const def = opp(eng, att);
  const densityCoefficient = action === "PASS"
    ? MS.actionQuality.passLocalDensityCoefficient
    : MS.actionQuality.localDensityCoefficient;
  const zExec = clamp(
    (actionQualityFor(sideOf(eng, att), eng.zone, action) - defensiveResistanceFor(def, eng.zone, action)) / Math.SQRT2 +
      densityCoefficient * (localDensity(sideOf(eng, att), eng.zone) - localDensity(def, eng.zone)),
    -MS.normalization.contestZClamp,
    MS.normalization.contestZClamp
  );
  const zPress = pressSignal(eng, def, eng.zone);
  // `utility` applies the configured tactical share exactly once.
  const continueU = utility(eng, Math.log(base.continue), zExec, -zPress, 0);
  const turnoverU = utility(eng, Math.log(base.turnover), -zExec, zPress, 0);
  const foulShift = foulContextShift(eng, def);
  const foulU = utility(eng, Math.log(base.foul), 0, 0, foulShift);
  const retainedU = utility(eng, Math.log(base.retainedRestart), 0, 0, 0);
  const out = choice(eng.rng, ["CONTINUE", "TURNOVER", "FOUL", "RETAINED_RESTART"], [continueU, turnoverU, foulU, retainedU]) as Outcome;
  if (eng.ratingObserver) {
    const weights = [continueU, turnoverU, foulU, retainedU].map((u) => Math.exp(Math.max(-50, Math.min(50, u))));
    const total = weights.reduce((s, w) => s + w, 0) || 1;
    const probs: Record<string, number | string> = {
      CONTINUE: weights[0] / total,
      TURNOVER: weights[1] / total,
      FOUL: weights[2] / total,
      RETAINED_RESTART: weights[3] / total,
      action,
    };
    emitDecision(eng, "outcome", probs, out, [...involvedIds(sideOf(eng, att), eng.zone), ...involvedIds(def, eng.zone)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Next zone (§13)
// ---------------------------------------------------------------------------

function destinationUtility(eng: Engine, action: string, next: MatchZone): number {
  const baseline = nextZoneBaseline(eng, action);
  const p0 = baseline[next] ?? 0;
  if (p0 <= 0) return -Infinity;
  const baseLogP = Math.log(p0);
  const currentRank = LONG_RANK[eng.zone];
  const nextRank = LONG_RANK[next];
  const progressDelta = nextRank - currentRank;
  const progressScore = clamp(progressDelta / 3, -1, 1);
  const retentionScore = 1 - Math.abs(progressScore);
  const side = sideOf(eng, eng.possessionSide);
  const style = side.tactics.style;
  const opponent = opp(eng, eng.possessionSide);
  const executionFactor = tacticalExecutionContrast(side.tactics.familiarity, opponent.tactics.familiarity);

  const components: number[] = [];
  components.push(shapeSignal(eng, next));
  let styleRaw = 0;
  if (style === "CONTROL") {
    styleRaw = retentionScore;
  } else if (style === "COUNTER") {
    if (eng.phase === "TRANSITION") {
      const expected = Math.max(expectedActionSeconds(action), MS.timing.instantActionSeconds);
      styleRaw = Math.max(progressDelta, 0) / expected;
    } else {
      styleRaw = 0;
    }
  }
  components.push(styleRaw * executionFactor);
  // Direction preference (lane handled separately, but include for wide/centre routing).
  const dir = directionSignal(eng, destinationLaneFor(eng, next)) * executionFactor;
  const zTacticsTotal = combineTactics(eng, [...components, dir]);
  // §5.5 Playmaking pathway: forward destination quality only. Retained,
  // lateral and backward destinations receive zero playmaking signal.
  const forwardFraction = Math.max(0, progressDelta) / 3;
  const creationQuality = localQuality(side, eng.zone, "playmaking");
  const zTeamProgression = MS.actionQuality.playmakingProgressionCoefficient * forwardFraction * creationQuality;
  // Home advantage creation: apply to attacking PROGRESSION utility (§29) so
  // the home team reaches advanced/box zones slightly more often.
  let cu = 0;
  if (eng.possessionSide === 0 && !eng.st.homeNeutral) {
    const nextRank = LONG_RANK[next];
    if (nextRank > currentRank && nextRank >= 2) {
      cu = Math.log(creationMultiplier(eng));
    }
  }
  return utility(eng, baseLogP, zTeamProgression, zTacticsTotal, cu);
}

function destinationLaneFor(eng: Engine, next: MatchZone): Lane {
  if (next === "BOX") return "CENTRE";
  const side = sideOf(eng, eng.possessionSide);
  const roll = nextDouble(eng.rng);
  if (side.tactics.direction === "WIDE") {
    // Wide bias: pick LEFT/RIGHT unless central.
    return roll < 0.7 ? (next.endsWith("WIDE") || next.startsWith("MID") ? (roll < 0.35 ? "LEFT" : "RIGHT") : "CENTRE") : "CENTRE";
  }
  return roll < 0.7 ? "CENTRE" : next.endsWith("WIDE") ? "RIGHT" : "CENTRE";
}

function pickNextZone(eng: Engine, action: string): MatchZone {
  const baseline = nextZoneBaseline(eng, action);
  const candidates = ZONES.filter((z) => (baseline[z] ?? 0) > 0);
  if (candidates.length === 0) return eng.zone;
  const utilities = candidates.map((z) => destinationUtility(eng, action, z));
  const chosen = choice(eng.rng, candidates, utilities) as MatchZone;
  if (eng.ratingObserver) {
    const weights = utilities.map((u) => Math.exp(Math.max(-50, Math.min(50, u))));
    const total = weights.reduce((s, w) => s + w, 0) || 1;
    const probs: Record<string, number | string> = {};
    candidates.forEach((z, i) => { probs[z] = weights[i] / total; });
    probs.action = action;
    emitDecision(eng, "next-zone", probs, chosen, involvedIds(sideOf(eng, eng.possessionSide), eng.zone));
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Restart sampling (§23)
// ---------------------------------------------------------------------------

function samplePossessionStart(eng: Engine, restart: string | null): { startZone: MatchZone; firstAction: string; startType: string } {
  const rows = MS.probabilityModel.possessionStartDistribution;
  const pool = restart ? rows.filter((r) => r.startType === restart) : rows;
  if (pool.length === 0) {
    const defStart = rows.filter((r) => r.startType === "OPEN_PLAY");
    const src = defStart.length > 0 ? defStart : rows;
    const total = src.reduce((s, r) => s + r.probability, 0);
    let roll = nextDouble(eng.rng) * total;
    for (const row of src) {
      roll -= row.probability;
      if (roll <= 0) return { startZone: row.startZone as MatchZone, firstAction: row.firstAction, startType: row.startType };
    }
    const last = src[src.length - 1];
    return { startZone: last.startZone as MatchZone, firstAction: last.firstAction, startType: last.startType };
  }
  const total = pool.reduce((s, r) => s + r.probability, 0);
  let roll = nextDouble(eng.rng) * total;
  for (const row of pool) {
    roll -= row.probability;
    if (roll <= 0) return { startZone: row.startZone as MatchZone, firstAction: row.firstAction, startType: row.startType };
  }
  const last = pool[pool.length - 1];
  return { startZone: last.startZone as MatchZone, firstAction: last.firstAction, startType: last.startType };
}

function beginPossession(eng: Engine, restart: string | null, keepLane = false, preferredCarrierId?: number | null): void {
  eng.possessionAgeSeconds = 0;
  eng.isCounter = false;
  eng.possessionHighRecovery = false;
  // A restart opens a fresh possession sequence: the previous passer no longer
  // assists a later goal (penalties come from fouls, so this also suppresses
  // penalty "assists").
  eng.lastPasserId = null;
  eng.lastPasserSide = null;
  // Count each possession for both teams (the possession side was set before
  // calling beginPossession).
  const ownerStats = eng.stats[eng.possessionSide === 0 ? "home" : "away"];
  ownerStats.possessions++;
  eng.possessionStarts++;
  const start = samplePossessionStart(eng, restart);
  eng.restartCounts[start.startType] = (eng.restartCounts[start.startType] ?? 0) + 1;
  eng.possessionStartType = start.startType;
  eng.zone = start.startZone;
  eng.lane = zoneToLane(start.startZone);
  if (!keepLane) eng.lane = zoneToLane(start.startZone);
  // SET_PIECE for restart-driven starts; TRANSITION for COUNTER starts.
  if (start.startType === "COUNTER") {
    eng.phase = "TRANSITION";
  } else if (start.startType !== "OPEN_PLAY" && start.startType !== "KEEPER" && start.startType !== "KICK_OFF") {
    eng.phase = "SET_PIECE";
  } else {
    eng.phase = phaseForZone(start.startZone);
  }
  eng.pendingFirstAction = start.firstAction;
  const preferred = preferredCarrierId == null
    ? null
    : sideOf(eng, eng.possessionSide).on.find((ps) => ps.id === preferredCarrierId)?.id ?? null;
  eng.ballCarrierId = preferred ?? presentationPlayerId(
    sideOf(eng, eng.possessionSide),
    eng.zone,
    null,
    eng.possessionStartType === "GOAL_KICK",
  );
}

function startBallAction(eng: Engine, action: string, side: 0 | 1, zone: MatchZone): LiveBallAction {
  const actorId = eng.ballCarrierId ?? presentationPlayerId(sideOf(eng, side), zone);
  const targetZone = presentationIntentZone(zone, action);
  const targetId = action === "CARRY" || action === "DRIBBLE"
    ? actorId
    : action === "PASS" || action === "CROSS" || action === "CLEARANCE"
      ? presentationPlayerId(sideOf(eng, side), targetZone, actorId)
      : null;
  eng.ballCarrierId = actorId;
  const record: LiveBallAction = {
    sequence: eng.ballActionSequence + 1,
    action,
    outcome: "PENDING",
    side,
    fromZone: zone,
    toZone: zone,
    fromPlayerId: actorId,
    targetPlayerId: targetId,
    interceptorId: null,
    foulerId: null,
  };
  eng.ballActionSequence = record.sequence;
  eng.lastBallAction = record;
  return record;
}

function finishBallAction(record: LiveBallAction, patch: Partial<LiveBallAction>): void {
  Object.assign(record, patch);
}

// ---------------------------------------------------------------------------
// Shots (§26-§31)
// ---------------------------------------------------------------------------

function shooterSelection(eng: Engine, side: Side): LivePlayerState {
  const zone = eng.zone;
  const candidates = involvedPlayers(side, zone).filter((l) => l.ps.deployedRole !== "GK");
  const fallback = side.on.find((ps) => ps.deployedRole !== "GK") ?? side.on[0];
  if (candidates.length === 0) return fallback ?? syntheticOutfielder(side);
  const weights = candidates.map((l) => {
    // Config validation guarantees a row for every deployed role, so an
    // absent weight is a bug, not a case to paper over with a default.
    const roleWeight = MS.shotModel.shooterRoleWeights[l.ps.deployedRole];
    const finishingZ = l.ps.zFinishing;
    const finishingFactor = Math.max(MS.shotModel.shooterFinishingFloor, finishingZ + MS.shotModel.shooterFinishingOffset);
    return Math.max(MS.shotModel.shooterMinimumWeight, l.weight * finishingFactor * roleWeight);
  });
  const labels = candidates.map((l) => String(l.ps.id));
  const chosen = weightedPick(eng.rng, labels, weights);
  return candidates.find((l) => String(l.ps.id) === chosen)?.ps ?? fallback ?? syntheticOutfielder(side);
}

/** Degenerate-state outfielder (whole side dismissed): neutral shot taker. */
function syntheticOutfielder(side: Side): LivePlayerState {
  const any = side.on[0];
  const base = {
    id: any?.id ?? -1,
    skills: any?.skills ?? { gol: 1, pace: 1, tec: 1, pas: 1, des: 1, playmaking: 1, fin: 1 },
    overall: any?.overall ?? 1,
    age: any?.age ?? 30,
    position: any?.position ?? ("ST" as const),
    deployedRole: "ST" as const,
    slotIndex: any?.slotIndex ?? 0,
    energy: any?.energy ?? 50,
    readiness: any?.readiness ?? 1,
    zTech: any?.zTech ?? 0,
    zPace: any?.zPace ?? 0,
    zPhysical: any?.zPhysical ?? 0,
    zFinishing: any?.zFinishing ?? 0,
    zGk: any?.zGk ?? 0,
    zDefending: any?.zDefending ?? 0,
    zPassing: (any as unknown as { zPassing?: number })?.zPassing ?? 0,
    zPlaymaking: (any as unknown as { zPlaymaking?: number })?.zPlaymaking ?? 0,
    baseZ: any?.baseZ ?? { tech: 0, pace: 0, physical: 0, finishing: 0, gk: 0, defending: 0, passing: 0, playmaking: 0 },
    physical: any?.physical ?? 0,
    onPitch: true,
  };
  return base;
}

const SHOT_ZONE_CENTRES: Record<MatchZone, { x: number; y: number }> = {
  DEF_WIDE: { x: 12, y: 66 },
  DEF_CENTRAL: { x: 14, y: 40 },
  MID_WIDE: { x: 45, y: 66 },
  MID_CENTRAL: { x: 50, y: 40 },
  ATT_WIDE: { x: 88, y: 66 },
  ATT_CENTRAL: { x: 95, y: 40 },
  BOX: { x: 111, y: 40 },
};

function shotLocationForZone(eng: Engine, zone: MatchZone): { x: number; y: number } {
  // Virtual pitch coordinates in 0-120 (x) by 0-80 (y) units; the goal is at
  // x=120, y=40. Seeded jitter spreads shots across the empirical distance and
  // angle bins rather than clustering at each zone's centre.
  const c = SHOT_ZONE_CENTRES[zone] ?? { x: 95, y: 40 };
  const jx = (nextDouble(eng.rng) - 0.5) * 14;
  const jy = (nextDouble(eng.rng) - 0.5) * 18;
  return { x: Math.max(2, Math.min(119, c.x + jx)), y: Math.max(2, Math.min(78, c.y + jy)) };
}

function shotGeometry(xNorm: number, yNorm: number): { distance: number; angle: number } {
  const g = MS.shotModel.geometry;
  const xM = (xNorm / 120) * g.pitchLengthMeters;
  const yM = (yNorm / 80) * g.pitchWidthMeters;
  const dx = g.pitchLengthMeters - xM;
  const dy = Math.abs(yM - g.pitchWidthMeters / 2);
  const distance = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(g.goalWidthMeters * dx, dx * dx + dy * dy - (g.goalWidthMeters / 2) ** 2);
  return { distance, angle };
}

function binLabel(bins: number[], value: number, maxLabel: string): string {
  for (let i = 0; i < bins.length - 1; i++) {
    if (value >= bins[i] && value < bins[i + 1]) return `D${bins[i]}_${bins[i + 1]}`;
  }
  if (value >= bins[bins.length - 1]) return `D${bins[bins.length - 1]}_PLUS`;
  return maxLabel;
}

function xgLookup(eng: Engine, distance: number, angle: number, situation: string, bodyPart: string, pressured: boolean): number {
  const g = MS.shotModel.geometry;
  const distBin = binLabel(g.distanceBinsMeters, distance, "D30_PLUS");
  const angleDeg = (angle * 180) / Math.PI;
  const angBin = binLabel(g.angleBinsDegrees, angleDeg, "A60_PLUS");
  const lookup = MS.shotModel.xgLookup;
  const exact = lookup.EXACT[`${distBin}.${angBin}.${situation}.${bodyPart}.${pressured}`];
  if (exact !== undefined) return exact;
  const noPress = lookup.NO_PRESSURE[`${distBin}.${angBin}.${situation}.${bodyPart}`];
  if (noPress !== undefined) return noPress;
  const sit = lookup.SITUATION[`${distBin}.${angBin}.${situation}`];
  if (sit !== undefined) return sit;
  const geom = lookup.GEOMETRY[`${distBin}.${angBin}`];
  if (geom !== undefined) return geom;
  const dist = lookup.DISTANCE[distBin];
  if (dist !== undefined) return dist;
  return lookup.GLOBAL.GLOBAL;
}

/** Situation label from possession start type / phase. */
function situationLabel(eng: Engine): string {
  if (eng.possessionStartType === "CORNER") return "CORNER_SEQUENCE";
  if (eng.possessionStartType === "FREE_KICK") return "FREE_KICK_SEQUENCE";
  if (eng.possessionStartType === "THROW_IN") return "THROW_IN_SEQUENCE";
  if (eng.possessionStartType === "PENALTY") return "PENALTY";
  if (eng.possessionStartType === "GOAL_KICK") return "OPEN_PLAY";
  return "OPEN_PLAY";
}

function shotQualityLogitShift(eng: Engine): number {
  if (!eng.st.homeNeutral) {
    return homeShotQualityLogitShift(eng);
  }
  return 0;
}

/** Defensive coverage for a shot includes the target zone and the
 * corresponding back-line zone that supports it. */
function shotDefenseDensity(side: Side, zone: MatchZone): number {
  const backLineZone = zone === "ATT_WIDE" ? "DEF_WIDE" : "DEF_CENTRAL";
  return (localDensity(side, zone) + localDensity(side, backLineZone)) / 2;
}

let _homeShift: [number | null, number | null] = [null, null];
function homeShotQualityLogitShift(eng: Engine): number {
  const side = eng.possessionSide;
  if (_homeShift[side] !== null) return _homeShift[side] as number;
  const baseTeamXg = MS.validation.reference["TEAM_MATCH.xG"]?.mean ?? 1.28;
  const baseTeamShots = MS.validation.reference["TEAM_MATCH.shots"]?.mean ?? 12.5;
  const p0 = baseTeamXg / baseTeamShots;
  const signedAdvantage = side === 0 ? MS.homeAdvantage.targetXg : -MS.homeAdvantage.targetXg;
  const p1 = clamp(p0 + (MS.homeAdvantage.shotQualityShare * signedAdvantage) / baseTeamShots, 0.002, 0.98);
  const shift = logit(p1) - logit(p0);
  _homeShift[side] = shift;
  return shift;
}

interface ShotResult {
  goal: boolean;
  onTarget: boolean;
  blocked: boolean;
  saved: boolean;
  woodwork: boolean;
  rebound: boolean;
  finalXg: number;
  shooter: LivePlayerState | null;
  /** Defending outfielder who blocked the attempt (SHOT_BLOCKED attribution). */
  blockerId: number | null;
  situation: string;
  pressured: boolean;
  distance: number;
}

function resolveShot(eng: Engine, side: Side, def: Side): ShotResult {
  let shooter = shooterSelection(eng, side);
  const { x, y } = shotLocationForZone(eng, eng.zone);
  const { distance, angle } = shotGeometry(x, y);
  const situation = situationLabel(eng);
  const bodyPart = nextDouble(eng.rng) < 0.7 ? "FOOT" : "HEAD";
  const pressured = pressSignal(eng, def, eng.zone) > 0.2;
  let baselineXg = xgLookup(eng, distance, angle, situation, bodyPart, pressured);

  // Penalty handling
  if (situation === "PENALTY") {
    const penaltyXg = MS.shotModel.xgLookup.EXACT["D6_12.A30_45.PENALTY.FOOT.false"] ?? 0.77;
    baselineXg = penaltyXg;
    // Honour a designated penalty taker (Club.penaltyTakerId, or a live-only
    // override set by a SET_TAKER automation rule, plan §11) if he's on the
    // pitch. This OVERRIDES who shoots, applied after shooterSelection has
    // already consumed its RNG draw above — the draw count, and therefore
    // every downstream RNG-derived outcome, is identical whether or not a
    // taker is designated, so this cannot shift calibration or determinism.
    const takerId = eng.st.livePenaltyTakerId?.[side.idx] ?? side.club.penaltyTakerId ?? null;
    if (takerId !== null) {
      const designated = side.on.find((ps) => ps.id === takerId && ps.deployedRole !== "GK");
      if (designated) shooter = designated;
    }
  }

  const zFinish = shooter.zFinishing;
  // The goalkeeper defends the conversion draw directly (plan §28): find the
  // GK on the pitch, not a zone-local quality (the GK's zone involvement is
  // only DEF_CENTRAL and shots occur in ATT/BOX zones).
  const gk = def.on.find((ps) => ps.deployedRole === "GK");
  const zGk = gk ? gk.zGk : 0;
  const shotSkillSignal = clamp((zFinish - zGk) / Math.SQRT2, -MS.normalization.contestZClamp, MS.normalization.contestZClamp);
  const densitySignal = localDensity(side, eng.zone) - shotDefenseDensity(def, eng.zone);
  const finalXg = logistic(
    logit(baselineXg) +
      MS.shotModel.finisherVsGoalkeeperLogitCoefficient * shotSkillSignal +
      shotQualityLogitShift(eng) +
      MS.shotModel.localDensityCoefficient * densitySignal,
  );
  const finalXgC = clamp(finalXg, 0.002, 0.98);

  const goal = nextDouble(eng.rng) < finalXgC;

  // On-target probability for non-goal resolution.
  const pOnTarget = clamp(
    MS.shotModel.shotsOnTarget.baseRate +
      MS.shotModel.shotsOnTarget.finishingCoefficient * zFinish -
      MS.shotModel.shotsOnTarget.pressurePenalty * (pressured ? 1 : 0),
    MS.shotModel.shotsOnTarget.min,
    MS.shotModel.shotsOnTarget.max
  );
  let onTarget = goal;
  let blocked = false;
  let woodwork = false;
  let saved = false;
  let rebound = false;
  let blockerId: number | null = null;
  if (!goal) {
    onTarget = nextDouble(eng.rng) < pOnTarget;
    if (onTarget) {
      const shares = MS.shotModel.nonGoalOutcome.onTarget;
      const outcome = weightedPick(eng.rng, ["SAVE_CONTROLLED", "SAVE_REBOUND", "WOODWORK"], [shares.saveControlled, shares.saveRebound, shares.woodwork]);
      saved = outcome === "SAVE_CONTROLLED" || outcome === "SAVE_REBOUND";
      woodwork = outcome === "WOODWORK";
      rebound = outcome === "SAVE_REBOUND";
    } else {
      const shares = MS.shotModel.nonGoalOutcome.notOnTarget;
      const blockP = pressured ? shares.blockUnderPressure : shares.blockNoPressure;
      const roll = nextDouble(eng.rng);
      if (roll < blockP) {
        blocked = true;
      } else if (roll < blockP + shares.woodwork) {
        woodwork = true;
      }
    }
    // Blocked-shot attribution: the defending outfielder with the strongest
    // zone involvement at the shot point (the one who gets the block). Reuses
    // the deterministic presentation picker — no RNG draw, so the outcome
    // stream is unchanged; goalkeepers never "block", saves are their own.
    if (blocked) {
      blockerId = presentationPlayerId(def, eng.zone);
    }
  }

  // Rating observer: capture the shot's actual outcome probabilities (the
  // engine's computed values, read-only; no RNG).
  const onTargetShares = MS.shotModel.nonGoalOutcome.onTarget;
  const offTargetShares = MS.shotModel.nonGoalOutcome.notOnTarget;
  const blockP = pressured ? offTargetShares.blockUnderPressure : offTargetShares.blockNoPressure;
  const shotProbs: Record<string, number | string> = {
    GOAL: finalXgC,
    SAVE: (1 - finalXgC) * pOnTarget * (onTargetShares.saveControlled + onTargetShares.saveRebound),
    BLOCK: (1 - finalXgC) * (1 - pOnTarget) * blockP,
    WOODWORK: (1 - finalXgC) * pOnTarget * onTargetShares.woodwork + (1 - finalXgC) * (1 - pOnTarget) * offTargetShares.woodwork,
    MISS: (1 - finalXgC) * (1 - pOnTarget) * (1 - blockP - offTargetShares.woodwork),
    baselineXg: finalXgC,
    pressured: pressured ? 1 : 0,
    zFinish,
    zGk,
  };
  // Only the shooter and goalkeeper have usable-Z terms in the shot model.
  // Other zone-involved attackers must not inherit the shooter's contribution.
  const shotParticipants = [shooter.id, ...(gk ? [gk.id] : [])];
  emitDecision(eng, "shot", shotProbs, goal ? "GOAL" : saved ? "SAVE" : blocked ? "BLOCK" : woodwork ? "WOODWORK" : "MISS", shotParticipants);

  return { goal, onTarget, blocked, saved, woodwork, rebound, blockerId, finalXg: finalXgC, shooter, situation, pressured, distance };
}

// ---------------------------------------------------------------------------
// Cards / injuries / fouls (§36-§38)
// ---------------------------------------------------------------------------

function cardRates(): { pYellow: number; pRed: number } {
  const foulMean = MS.validation.reference["MATCH.totalFouls"]?.mean ?? 30;
  return {
    pYellow: MS.cards.yellowTargetPerMatch / foulMean,
    pRed: MS.cards.redTargetPerMatch / foulMean,
  };
}

function cardLogitShift(eng: Engine, fouler: LivePlayerState, def: Side): number {
  // §5.6: the fouler's defending Z controls card risk; higher defending reduces it.
  const disciplineRisk = defendingRisk(fouler.zDefending);
  const fatigueRisk = 1 - fouler.readiness;
  const pressIntensity = def.tactics.pressing;
  const maxStateV = 0.3;
  const highThreat = clamp(stateValue(eng) / maxStateV, 0, 1);
  return (
    MS.cards.disciplineRiskLogitCoefficient * disciplineRisk +
    MS.cards.fatigueLogitCoefficient * fatigueRisk +
    MS.cards.pressIntensityLogitCoefficient * pressIntensity +
    MS.cards.highThreatLogitCoefficient * highThreat
  );
}

function stateValue(eng: Engine): number {
  // Approximate current-state value via EPV table (computed once).
  const row = epvTable[stateKey(eng.phase, eng.zone)];
  return row ?? 0.05;
}

/** EPV threat for the currently-possessing side (mirrors stateValue). Exposed
 *  to the rating observer for expected-threat utilities. Clamped to a bounded
 *  [0,1] probability so an EPV-table anomaly can never poison rating math. */
function possessionThreat(eng: Engine): number {
  const v = stateValue(eng);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.05;
}

const epvTable: Record<string, number> & { __computed?: boolean } = {};

function selectFouler(eng: Engine, def: Side): LivePlayerState {
  const local = involvedPlayers(def, eng.zone);
  const pool = (local.length > 0 ? local : def.on.map((ps) => ({ ps, weight: 1 }))).filter((l) => l.ps);
  if (pool.length === 0) {
    // No on-pitch defender can be named (e.g. every defender dismissed): fall
    // back to the first player of the defending side's XI still on record.
    const any = eng.onPitchBySide[def.idx][0];
    if (any) return { id: any.id, skills: any.skills, overall: any.overall, age: any.age, position: any.position, deployedRole: "CB", slotIndex: 0, energy: any.energy, readiness: 1, zTech: 0, zPace: 0, zPhysical: 0, zFinishing: 0, zGk: 0, zDefending: 0, zPassing: 0, zPlaymaking: 0, onPitch: true } as LivePlayerState;
    return def.on[0] ?? {
      id: -1, skills: { gol: 1, pace: 1, tec: 1, pas: 1, des: 1, playmaking: 1, fin: 1 }, overall: 1, age: 30, position: "CB", deployedRole: "CB", slotIndex: 0, energy: 50, readiness: 1, zTech: 0, zPace: 0, zPhysical: 0, zFinishing: 0, zGk: 0, zDefending: 0, zPassing: 0, zPlaymaking: 0, onPitch: true,
    } as LivePlayerState;
  }
  const weights = pool.map((l) => {
    const press = l.ps.deployedRole !== "GK" ? l.weight * (0.4 + 0.6 * (1 - l.ps.readiness)) : 0;
    return Math.max(0.01, press);
  });
  const labels = pool.map((l) => String(l.ps.id));
  const chosen = weightedPick(eng.rng, labels, weights);
  return pool.find((l) => String(l.ps.id) === chosen)?.ps ?? pool[0].ps;
}

function resolveCards(eng: Engine, fouler: LivePlayerState, def: Side, minute: number, addedTime?: number): void {
  const { pYellow, pRed } = cardRates();
  const shift = cardLogitShift(eng, fouler, def);
  const redU = logit(pRed) + shift;
  const redP = logistic(redU);
  const alreadyBooked = (eng.playerYellows[fouler.id] ?? 0) >= 1;
  const yellowU = logit(pYellow) + shift - (alreadyBooked ? MS.cards.secondYellowLogitPenalty : 0);
  const yellowP = logistic(yellowU);

  emitDecision(eng, "cards", { pRed, pYellow, secondYellow: alreadyBooked ? 1 : 0 }, "", [fouler.id]);

  const isRed = nextDouble(eng.rng) < redP;
  const isYellow = !isRed && nextDouble(eng.rng) < yellowP;

  const club = def.club;
  const evExtra = addedTime !== undefined ? { addedTime } : {};
  if (isRed) {
    eng.cards.push({ playerId: fouler.id, kind: "RED", minute });
    eng.stats[def.idx === 0 ? "home" : "away"].reds++;
    eng.events.push({
      minute, half: eng.period, type: EVENT_CODES.RED, subtype: 0, clubId: club.id, playerId: fouler.id, player2Id: null, goalType: 0,
      ...evExtra,
    });
    removeFromPitch(eng, def, fouler.id);
  } else if (isYellow) {
    const count = (eng.playerYellows[fouler.id] ?? 0) + 1;
    eng.playerYellows[fouler.id] = count;
    if (count >= 2) {
      eng.cards.push({ playerId: fouler.id, kind: "YELLOW_RED", minute });
      eng.stats[def.idx === 0 ? "home" : "away"].reds++;
      eng.events.push({
        minute, half: eng.period, type: EVENT_CODES.YELLOW_RED, subtype: 0, clubId: club.id, playerId: fouler.id, player2Id: null, goalType: 0,
        ...evExtra,
      });
      removeFromPitch(eng, def, fouler.id);
    } else {
      eng.cards.push({ playerId: fouler.id, kind: "YELLOW", minute });
      eng.stats[def.idx === 0 ? "home" : "away"].yellows++;
      eng.events.push({
        minute, half: eng.period, type: EVENT_CODES.YELLOW, subtype: 0, clubId: club.id, playerId: fouler.id, player2Id: null, goalType: 0,
        ...evExtra,
      });
    }
  }
}

function removeFromPitch(eng: Engine, side: Side, playerId: number): void {
  side.on = side.on.filter((ps) => ps.id !== playerId);
  eng.onPitchBySide[side.idx] = eng.onPitchBySide[side.idx].filter((p) => p.id !== playerId);
  // §9.1: red cards/injuries remove the player's live slot-map entry.
  const slotMap = side.idx === 0 ? eng.st.homeSlotByPlayerId : eng.st.awaySlotByPlayerId;
  if (slotMap) delete slotMap[playerId];
  side.rosterVersion++;
  computeSupport(side);
}

/**
 * Bench player who replaces a player removed by a match injury. §9.5: an
 * incoming GK is required only when replacing the GK slot; a GK can never
 * enter an outfield slot. Outfield picks rank by adjusted pair score for the
 * outgoing role (no exact-natural-position preference ahead of score).
 * Deterministic (adjusted rating desc, then lower id): no RNG draw, so instant
 * and streamed runs — and restarts — always agree. Exported for tests.
 */
export function pickInjuryReplacement(
  bench: Player[],
  outRole: DeployedRole,
  energyOf: (p: Player) => number = (p) => p.energy,
): Player | null {
  const eligible = bench.filter((p) => p.injuryDays === 0 && p.suspendedGames === 0);
  // §9.2 pair score: adjusted role rating × readiness. Energy belongs in the
  // ranking — a fresher bench player can legitimately beat a marginally better
  // but exhausted one, and the AI tactical sub already scores this way.
  const score = (p: Player): number | null => {
    const rating = adjustedRoleRating(p.skills, p.position, outRole);
    return rating === null ? null : rating * readiness(clamp(energyOf(p), 0, 100));
  };
  const scored = eligible
    .map((p) => ({ p, s: score(p) }))
    .filter((entry): entry is { p: Player; s: number } => entry.s !== null);
  scored.sort((a, b) => (Math.abs(b.s - a.s) > 1e-9 ? b.s - a.s : b.p.overall - a.p.overall || a.p.id - b.p.id));
  return scored[0]?.p ?? null;
}

/**
 * Shared engine-side substitution bookkeeping (injury auto-sub and AI tactical
 * subs). Mirrors `performLiveSub` inside the engine so the change is picked up
 * immediately and survives persistence: pitch/bench lists, slot counter, SUB
 * event + substitution record, and the energy/load/minutes maps the full-time
 * commit reads. The replacement inherits the outgoing player's tactical slot.
 */
function applyEngineSub(eng: Engine, side: Side, outPs: LivePlayerState, incoming: Player, minute: number): void {
  // §9.5: every incoming player inherits the exact outgoing slot index, so the
  // deployed role is preserved without storing role state on the Player.
  const slotMap = side.idx === 0 ? eng.st.homeSlotByPlayerId : eng.st.awaySlotByPlayerId;
  const slotIndex = outPs.slotIndex;
  if (slotMap && slotIndex >= 0) {
    slotMap[incoming.id] = slotIndex;
    delete slotMap[outPs.id];
  }
  const { role } = deployedRoleForSlot(slotMap, side.tactics.formation, incoming.id);
  const ps = buildPlayerState(incoming, eng.centers, role, slotIndex, eng.st.playerEnergy[incoming.id] ?? incoming.energy);
  // Take the outgoing player off the pitch (mirrors removeFromPitch's list
  // bookkeeping; support is recomputed once below).
  side.on = side.on.filter((candidate) => candidate.id !== outPs.id);
  eng.onPitchBySide[side.idx] = eng.onPitchBySide[side.idx].filter((p) => p.id !== outPs.id);
  side.on.push(ps);
  side.rosterVersion++;
  eng.onPitchBySide[side.idx].push(incoming);
  side.bench = side.bench.filter((p) => p.id !== incoming.id);
  const persistedBench = side.idx === 0 ? eng.st.homeSubs : eng.st.awaySubs;
  const bIdx = persistedBench.indexOf(incoming.id);
  if (bIdx >= 0) persistedBench.splice(bIdx, 1);
  eng.st.usedSubs[side.idx]++;
  // Mirror performLiveSub's ledger so future consumers of subbedIn see
  // engine-driven replacements too.
  eng.st.subbedIn ??= [[], []];
  eng.st.subbedIn[side.idx].push(incoming.id);
  eng.substitutions.push({ minute, outId: outPs.id, inId: incoming.id });
  eng.events.push({ minute, half: eng.period, type: EVENT_CODES.SUB, subtype: 0, clubId: side.club.id, playerId: outPs.id, player2Id: incoming.id, goalType: 0 });
  // Seed the workload maps exactly like performLiveSub: energy from his
  // persisted value, match-load counter from zero, pre-match load snapshot for
  // the full-time commit (writeBack never overwrites it).
  eng.st.playerEnergy ??= {};
  eng.st.playerEnergy[incoming.id] = ps.energy;
  eng.st.playerPreMatchLoad ??= {};
  eng.st.playerPreMatchLoad[incoming.id] = incoming.recentLoad ?? 0;
  eng.playerRecentLoad[incoming.id] = incoming.recentLoad ?? 0;
  eng.playerMatchLoad[incoming.id] = 0;
  eng.playerMinutes[incoming.id] ??= 0;
  computeSupport(side);
}

/**
 * Automatic substitution for a player just removed by a match injury
 * (`gameConfig.injuries.autoSubstitute`). Consumes one of the side's shared
 * substitution slots; without slots or an eligible candidate the team simply
 * continues one player short (red-card semantics, plan 9 §17).
 *
 * Idempotent across chunks: the next engine build starts from persisted state
 * where the injured player is already off the pitch, so this fires exactly once
 * per injury.
 */
function applyInjuryAutoSub(eng: Engine, side: Side, outPs: LivePlayerState, minute: number): void {
  if (!gameConfig.injuries.autoSubstitute) return;
  if ((eng.st.usedSubs[side.idx] ?? 0) >= MP_CONFIG.maxSubsPerSide) return;
  const incoming = pickInjuryReplacement(side.bench, outPs.deployedRole, (p) => eng.st.playerEnergy?.[p.id] ?? p.energy);
  if (!incoming) return;
  applyEngineSub(eng, side, outPs, incoming, minute);
}

// ---------------------------------------------------------------------------
// AI tactical substitutions (plan 6 §40). Evaluated once per match minute for
// AI-controlled sides only; fully deterministic so restarts and chunked
// advances agree without consuming RNG draws.
// ---------------------------------------------------------------------------

/** Normalized card/injury-risk pressure of an on-pitch player: how far his
 *  current injury hazard sits above the neutral reference (half the term),
 *  plus a flat component while he carries a yellow. */
function aiCardOrInjuryRisk(eng: Engine, ps: LivePlayerState): number {
  const reference = injuryRiskMultiplier(
    ENERGY_INJURY_MODEL.injuryRisk.referenceEnergy,
    ENERGY_INJURY_MODEL.injuryRisk.referenceRecentLoad,
    ENERGY_INJURY_MODEL.injuryRisk.ageReference,
  );
  const recentLoad = eng.playerRecentLoad[ps.id] ?? 0;
  const ratio = injuryRiskMultiplier(ps.energy, recentLoad, ps.age) / reference;
  const yellowed = (eng.playerYellows[ps.id] ?? 0) > 0 ? 0.5 : 0;
  return Math.min(1, yellowed + 0.5 * Math.max(0, ratio - 1));
}

/**
 * Bench candidate maximizing the §40 replacement value against the outgoing
 * player's deployed role:
 *   effectiveSkill·w + energy·w (adjusted role rating, no separate fit term)
 * Goalkeepers are never eligible: tactical subs always replace an outfielder
 * (the need scan skips GKs), mirroring pickInjuryReplacement's GK invariant.
 * Deterministic (value desc, then lower id): no RNG draw, so instant and
 * streamed runs — and restarts — always agree. Exported for tests.
 */
export function pickAiReplacement(bench: Player[], outRole: DeployedRole, energyOf: (id: number) => number): Player | null {
  const weights = MS.substitutionAi.replacementWeights as { effectiveSkill: number; energy: number };
  const eligible = bench.filter((p) => (p.position as string) !== "GK" && p.injuryDays === 0 && p.suspendedGames === 0);
  const value = (p: Player): number =>
    weights.effectiveSkill * (tacticalSkillRating(adjustedSkillsForRole(p, outRole), outRole) / 100) +
    weights.energy * (clamp(energyOf(p.id), 0, 100) / 100);
  let best: Player | null = null;
  let bestValue = -Infinity;
  for (const p of eligible) {
    const v = value(p);
    if (v > bestValue || (v === bestValue && best !== null && p.id < best.id)) {
      best = p;
      bestValue = v;
    }
  }
  return best;
}

/** Substitution need of one on-pitch outfielder (plan 6 §40). */
function aiSubNeed(eng: Engine, side: Side, ps: LivePlayerState): number {
  const cfg = MS.substitutionAi;
  const goalDiff = eng.scores[side.idx] - eng.scores[1 - side.idx];
  const timeUrgency = logistic((eng.clockSeconds - MS.aiTactics.urgencyMidpointSeconds) / MS.aiTactics.urgencyScaleSeconds);
  const scoreUrgency = timeUrgency * (clamp(-goalDiff, 0, 2) / 2);
  const zoneDeficit = side.on.length < 11 ? 1 : 0;
  const fatigue = clamp((cfg.fatigueNeedEnergyThreshold - ps.energy) / cfg.fatigueNeedEnergyThreshold, 0, 1);
  return (
    cfg.needWeights.fatigue * fatigue +
    cfg.needWeights.zoneDeficit * zoneDeficit +
    cfg.needWeights.scoreUrgency * scoreUrgency +
    cfg.needWeights.cardOrInjuryRisk * aiCardOrInjuryRisk(eng, ps)
  );
}

/** One AI tactical-sub attempt for a side; true when a change was made. */
function tryAiSubstitution(eng: Engine, side: Side, minute: number): boolean {
  const cfg = MS.substitutionAi;
  let bestPs: LivePlayerState | null = null;
  let bestNeed = -Infinity;
  for (const ps of side.on) {
    // Goalkeepers are never removed tactically; fresh subs need pitch time.
    if (ps.deployedRole === "GK") continue;
    if ((eng.playerMinutes[ps.id] ?? 0) < cfg.minOnPitchMinutes) continue;
    const need = aiSubNeed(eng, side, ps);
    if (need > bestNeed || (need === bestNeed && bestPs !== null && ps.id < bestPs.id)) {
      bestPs = ps;
      bestNeed = need;
    }
  }
  if (!bestPs || bestNeed < cfg.minNeedToSub) return false;
  const energyOf = (id: number): number => eng.st.playerEnergy[id] ?? side.bench.find((p) => p.id === id)?.energy ?? 0;
  const incoming = pickAiReplacement(side.bench, bestPs.deployedRole, energyOf);
  if (!incoming) return false;
  applyEngineSub(eng, side, bestPs, incoming, minute);
  return true;
}

/**
 * Per-minute AI substitution check inside the run loop. Only AI sides act
 * (`!club.isHuman` — human sides keep their automation rules); every side is
 * evaluated at most once per match minute via `aiSubLastMinute`, which persists
 * through writeBack so a rebuilt engine cannot re-evaluate the same minute.
 */
function evaluateAiSubstitutions(eng: Engine): void {
  const cfg = MS.substitutionAi;
  const minute = Math.floor(eng.clockSeconds / 60);
  if (minute < cfg.earliestMatchMinute || minute > cfg.latestMatchMinute) return;
  const cap = Math.min(cfg.maxPerSide, MP_CONFIG.maxSubsPerSide);
  for (const side of [eng.home, eng.away]) {
    if (side.club.isHuman) continue;
    if (minute <= eng.aiSubLastMinute[side.idx]) continue;
    eng.aiSubLastMinute[side.idx] = minute;
    if ((eng.st.usedSubs[side.idx] ?? 0) >= cap) continue;
    tryAiSubstitution(eng, side, minute);
  }
}

/** Injury hazard check for the acting side (plan §37). Normalized so neutral
 *  simulations average `injuries.targetPerMatch`. A single RNG draw per action
 *  keeps the stream chunk-independent (determinism between instant and
 *  streamed simulation). */
// Every term below comes purely from config and the versioned energy/injury
// model, yet the hazard runs once per resolved action (~950 a match). They are
// derived once on first use instead of on every action.
let _hazardConstants: { matchTargetPerMatch: number; meanRawActionRisk: number; baseHazardPerAction: number } | null = null;
function hazardConstants(): { meanRawActionRisk: number; baseHazardPerAction: number } {
  if (_hazardConstants && _hazardConstants.matchTargetPerMatch === gameConfig.injuries.matchTargetPerMatch) return _hazardConstants;
  const expectedActionsPerMatch = 2 * (MS.validation.reference["TEAM_MATCH.modeledActions"]?.mean ?? 956);
  const rawActions = ENERGY_INJURY_MODEL.injuryRisk.actionRiskRaw;
  // Spec §13.5 normalizes with the neutral empirical action distribution from
  // football-baseline.json; that artifact is not in the repository yet, so the
  // unweighted mean over the versioned table stands in until it lands.
  const meanRawActionRisk = Object.values(rawActions).reduce((sum, value) => sum + value, 0) / Object.values(rawActions).length;
  const referenceRisk = injuryRiskMultiplier(ENERGY_INJURY_MODEL.injuryRisk.referenceEnergy, ENERGY_INJURY_MODEL.injuryRisk.referenceRecentLoad, ENERGY_INJURY_MODEL.injuryRisk.ageReference);
  _hazardConstants = {
    matchTargetPerMatch: gameConfig.injuries.matchTargetPerMatch,
    meanRawActionRisk,
    baseHazardPerAction: gameConfig.injuries.matchTargetPerMatch / Math.max(1, expectedActionsPerMatch * referenceRisk),
  };
  return _hazardConstants;
}

function resolveInjuryHazard(eng: Engine, action: string, minute: number, addedTime?: number): void {
  const rawActions = ENERGY_INJURY_MODEL.injuryRisk.actionRiskRaw;
  const rawAction = rawActions[action] ?? rawActions.PASS;
  const { meanRawActionRisk, baseHazardPerAction } = hazardConstants();
  const participants: { ps: LivePlayerState; player: Player; side: Side; weight: number; lambda: number }[] = [];
  for (const currentSide of [eng.home, eng.away]) {
    for (const { ps, weight } of involvedPlayers(currentSide, eng.zone)) {
      const player = eng.onPitchBySide[currentSide.idx].find((candidate) => candidate.id === ps.id);
      if (!player) continue;
      const recentLoad = eng.playerRecentLoad[ps.id] ?? 0;
      participants.push({ ps, player, side: currentSide, weight, lambda: baseHazardPerAction * injuryRiskMultiplier(ps.energy, recentLoad, ps.age) });
    }
  }
  const exposureTotal = participants.reduce((sum, participant) => sum + Math.max(0, participant.weight), 0);
  if (exposureTotal <= 0) return;
  let lambdaAction = 0;
  for (const participant of participants) {
    participant.lambda *= participant.weight / exposureTotal * rawAction / Math.max(1e-9, meanRawActionRisk);
    lambdaAction += participant.lambda;
  }
  if (nextDouble(eng.rng) >= 1 - Math.exp(-lambdaAction)) return;
  let roll = nextDouble(eng.rng) * lambdaAction;
  for (const participant of participants) {
    roll -= participant.lambda;
    if (roll > 0) continue;
    const result = recordInjury(eng.rng, participant.player, "MATCH", eng.st.absoluteGameDay ?? 0, eng.st.roundsPerSeason, eng.st.matchSpacingDays);
    eng.st.playerEnergy ??= {};
    eng.st.playerEnergy[participant.ps.id] = participant.ps.energy;
    eng.injuries.push({ playerId: participant.ps.id, days: result.days, minute, equivalentRealDays: result.equivalentRealDays, cause: "MATCH" });
    eng.stats[participant.side.idx === 0 ? "home" : "away"].injuries++;
    eng.events.push({ minute, half: eng.period, type: EVENT_CODES.INJURY, subtype: 0, clubId: participant.side.club.id, playerId: participant.ps.id, player2Id: null, goalType: result.days, ...(addedTime !== undefined ? { addedTime } : {}) });
    participant.ps.onPitch = false;
    removeFromPitch(eng, participant.side, participant.ps.id);
    applyInjuryAutoSub(eng, participant.side, participant.ps, minute);
    return;
  }
}

// ---------------------------------------------------------------------------
// Fatigue (§35)
// ---------------------------------------------------------------------------

function fatigueEnergyLoss(eng: Engine, side: Side, dtSeconds: number): void {
  const minutes = dtSeconds / 60;
  const workloadMultiplier = remainingPlayerWorkloadMultiplier(side.on.length);
  for (const ps of side.on) {
    const involvementWeight = involvement(ps.deployedRole, eng.zone);
    const press = side.tactics.pressing * 100;
    ps.energy = Math.max(0, ps.energy - workloadMultiplier * energyLoss({ energy: ps.energy, age: ps.age, physicalSkill: ps.physical, position: ps.deployedRole, pressing: press, involvement: involvementWeight, minutes }));
    eng.playerMatchLoad[ps.id] = (eng.playerMatchLoad[ps.id] ?? 0) + workloadMultiplier * loadIncrement({ position: ps.deployedRole, pressing: press, involvement: involvementWeight, minutes });
    refreshReadiness(ps);
  }
  // Formation support/coverage feeds tactical and organisation signals, so it
  // must follow the same readiness changes in instant and streamed runs.
  computeSupport(side);
}

// ---------------------------------------------------------------------------
// Defensive organisation (§24)
// ---------------------------------------------------------------------------

function baselineOrganisation(side: Side): number {
  const localCoverage = ZONES.reduce((s, z) => s + side.coverage[z], 0) / (side.expectedSupportTotal ?? 7);
  const meanReadiness = side.on.length > 0 ? side.on.reduce((s, p) => s + p.readiness, 0) / side.on.length : 1;
  return clamp(
    MS.defensiveOrganisation.baselineIntercept +
      MS.defensiveOrganisation.formationCoverageWeight * localCoverage +
      MS.defensiveOrganisation.readinessWeight * meanReadiness,
    MS.defensiveOrganisation.min,
    MS.defensiveOrganisation.max
  );
}

function committedForward(side: Side): number {
  return side.on.filter((ps) => ["ST", "LW", "RW", "AM"].includes(ps.deployedRole)).length;
}

function disruptionAfterTurnover(eng: Engine, def: Side): { disruption: number; recoveryTime: number } {
  const advancedRecoveryValue = LONG_RANK[eng.zone] / 3;
  const commitment = clamp(committedForward(def) / MS.defensiveOrganisation.playersCommittedForwardNormalizer, 0, 1);
  const pressExposure = def.tactics.pressing;
  const disruption = clamp(
    MS.defensiveOrganisation.disruptionAdvancedRecoveryWeight * advancedRecoveryValue +
      MS.defensiveOrganisation.disruptionCommitmentWeight * commitment +
      MS.defensiveOrganisation.disruptionPressExposureWeight * pressExposure,
    0,
    1
  );
  const paceZ = def.on.length > 0 ? weightedMean(def.on.map((p) => p.zPace), def.on.map(() => 1)) : 0;
  const paceNorm = clamp((paceZ / MS.normalization.rawZClamp + 1) / 2, 0, 1);
  const meanReadiness = def.on.length > 0 ? def.on.reduce((s, p) => s + p.readiness, 0) / def.on.length : 1;
  const recoveryQuality = clamp(
    MS.defensiveOrganisation.recoveryPaceWeight * paceNorm + MS.defensiveOrganisation.recoveryReadinessWeight * meanReadiness,
    MS.defensiveOrganisation.minRecoveryQuality,
    1
  );
  const recoveryTime = MS.defensiveOrganisation.recoveryBaseSeconds / recoveryQuality;
  return { disruption, recoveryTime };
}

function updateOrganisation(eng: Engine, dtSeconds: number): void {
  for (const side of [eng.home, eng.away]) {
    const baseline = side.cachedBaselineOrganisation;
    side.baselineOrganisation = baseline;
    if (side.organisationDisruption > 0) {
      const recovery = Math.exp(-dtSeconds / Math.max(1e-6, side.organisationRecoveryTime));
      side.organisationDisruption *= recovery;
    }
    side.organisation = clamp(baseline - side.organisationDisruption, 0, 1);
  }
}

// ---------------------------------------------------------------------------
// Stoppage time (event-driven added time per half)
// ---------------------------------------------------------------------------

function computeAddedMinutesForHalf(eng: Engine, half: 1 | 2): number {
  const cfg = MS.timing.stoppage;
  if (!cfg) return 0;
  const base = half === 1 ? cfg.firstHalfBaseSeconds : cfg.secondHalfBaseSeconds;
  let goals = 0;
  let subs = 0;
  let injuries = 0;
  let cards = 0;
  for (const e of eng.events) {
    if (e.type === EVENT_CODES.GOAL && e.half === half) goals++;
  }
  for (const s of eng.substitutions) {
    const m = s.minute;
    if (half === 1 ? m <= 45 : m > 45) subs++;
  }
  for (const c of eng.cards) {
    const m = c.minute;
    if (half === 1 ? m <= 45 : m > 45) cards++;
  }
  for (const inj of eng.injuries) {
    const m = inj.minute;
    if (half === 1 ? m <= 45 : m > 45) injuries++;
  }
  const totalSeconds =
    base +
    goals * cfg.secondsPerGoal +
    subs * cfg.secondsPerSubstitution +
    injuries * cfg.secondsPerInjury +
    cards * cfg.secondsPerCard;
  const minSec = cfg.minMinutesPerHalf * 60;
  const maxSec = cfg.maxMinutesPerHalf * 60;
  const clamped = Math.max(minSec, Math.min(maxSec, totalSeconds));
  return Math.ceil(clamped / 60);
}

function ensureStoppageComputed(eng: Engine): void {
  // First half added time is frozen the first time the clock reaches the raw boundary.
  if (eng.clockSeconds >= MS.timing.firstHalfEndSeconds && (eng.st.firstHalfAddedMinutes ?? 0) === 0) {
    // Do not recompute if already set to a non-zero value; 0 is sentinel for "not yet computed"
    // (minMinutesPerHalf is 1 so a valid computed value is never 0).
    eng.st.firstHalfAddedMinutes = computeAddedMinutesForHalf(eng, 1);
  }
  const firstAdded = eng.st.firstHalfAddedMinutes ?? 0;
  const secondThreshold = MS.timing.regulationSeconds + firstAdded * 60;
  if (eng.clockSeconds >= secondThreshold && (eng.st.secondHalfAddedMinutes ?? 0) === 0) {
    eng.st.secondHalfAddedMinutes = computeAddedMinutesForHalf(eng, 2);
  }
}

function stoppageInfoForClock(eng: Engine, clockSeconds: number): { inStoppage: boolean; baseMinute: number; addedTime?: number } | null {
  const firstAdded = eng.st.firstHalfAddedMinutes ?? 0;
  const secondAdded = eng.st.secondHalfAddedMinutes ?? 0;
  const firstRaw = MS.timing.firstHalfEndSeconds;
  const regRaw = MS.timing.regulationSeconds;
  const secondStart = firstRaw + firstAdded * 60;
  const secondEnd = regRaw + firstAdded * 60;
  if (firstAdded > 0 && clockSeconds >= firstRaw && clockSeconds < firstRaw + firstAdded * 60 && eng.period === 1) {
    const elapsed = Math.floor((clockSeconds - firstRaw) / 60) + 1;
    return { inStoppage: true, baseMinute: 45, addedTime: Math.min(elapsed, firstAdded) };
  }
  if (secondAdded > 0 && clockSeconds >= secondEnd && clockSeconds < secondEnd + secondAdded * 60 && eng.period === 2) {
    const elapsed = Math.floor((clockSeconds - secondEnd) / 60) + 1;
    return { inStoppage: true, baseMinute: 90, addedTime: Math.min(elapsed, secondAdded) };
  }
  // Clock in stoppage but added not yet computed (should not happen — ensureStoppageComputed handles)
  return null;
}

function displayMinuteForClock(eng: Engine, clockSeconds: number): { minute: number; addedTime?: number; half: number } {
  const info = stoppageInfoForClock(eng, clockSeconds);
  if (info) return { minute: info.baseMinute, addedTime: info.addedTime, half: eng.period };
  const firstAdded = eng.st.firstHalfAddedMinutes ?? 0;
  // Second-half minutes must be offset by first-half added time (clock is continuous,
  // but the displayed minute should be 46 at the start of the second half).
  const effectiveClock = eng.period === 2 && clockSeconds >= MS.timing.firstHalfEndSeconds + firstAdded * 60
    ? clockSeconds - firstAdded * 60
    : clockSeconds;
  const minute = Math.floor(effectiveClock / 60) + 1;
  return { minute, half: eng.period };
}

// ---------------------------------------------------------------------------
// Counter activation (§25)
// ---------------------------------------------------------------------------

function tryActivateCounter(eng: Engine): void {
  const att = eng.possessionSide;
  const def = opp(eng, att);
  const advancedRecoveryValue = LONG_RANK[eng.zone] / 3;
  const commitment = clamp(committedForward(def) / MS.defensiveOrganisation.playersCommittedForwardNormalizer, 0, 1);
  const counterOpportunity = advancedRecoveryValue * commitment * (1 - def.organisation);
  const counterSide = sideOf(eng, att);
  const counterOpponent = opp(eng, att);
  const counterExecution = tacticalExecutionContrast(counterSide.tactics.familiarity, counterOpponent.tactics.familiarity);
  const counterSignal =
    counterOpportunity *
    (MS.counterattack.familiarityFloorWeight + MS.counterattack.familiarityExecutionWeight * counterExecution);
  const pTransition = logistic(MS.counterattack.activationLogisticSlope * (counterSignal - MS.counterattack.activationThreshold));
  if (nextDouble(eng.rng) < pTransition) {
    eng.phase = "TRANSITION";
    eng.isCounter = true;
    const stats = eng.stats[att === 0 ? "home" : "away"];
    stats.counterattacks++;
  }
}

// ---------------------------------------------------------------------------
// EPV (§32)
// ---------------------------------------------------------------------------

function computeEpv(): void {
  if (epvTable.__computed) return;
  epvTable.__computed = true;
  const meanShotValue = MS.shotModel.xgLookup.GLOBAL.GLOBAL;
  const states = ZONES.flatMap((zone) => ["SET_PIECE", "TRANSITION", "BUILD_UP", "PROGRESSION", "FINAL_THIRD"].map((phase) => `${phase}.${zone}`));
  const V: Record<string, number> = {};
  for (const s of states) {
    const row = MS.probabilityModel.state[s];
    const pShot = row?.intentProbabilities.SHOT ?? 0;
    V[s] = pShot * meanShotValue;
  }
  const { convergenceTolerance, maxIterations } = MS.epv;
  for (let iter = 0; iter < maxIterations; iter++) {
    let maxDiff = 0;
    for (const s of states) {
      const [phaseStr, zoneStr] = s.split(".");
      const zone = zoneStr as MatchZone;
      const row = MS.probabilityModel.state[s];
      const pShot = row?.intentProbabilities.SHOT ?? 0;
      let sum = pShot * meanShotValue;
      for (const action of INTENT_ACTIONS) {
        if (action === "SHOT") continue;
        const out = MS.probabilityModel.outcomeByStateAction[`${s}.${action}`];
        if (!out) continue;
        const next = MS.probabilityModel.nextZoneByStateAction[`${s}.${action}`];
        if (!next) continue;
        const pCont = out.continue / (out.continue + out.turnover + out.foul + out.retainedRestart);
        for (const [nz, p] of Object.entries(next)) {
          const destPhase = phaseForZone(nz as MatchZone);
          sum += pCont * p * (V[`${destPhase}.${nz}`] ?? 0);
        }
      }
      void phaseStr;
      void zone;
      const diff = Math.abs(V[s] - sum);
      if (diff > maxDiff) maxDiff = diff;
      V[s] = sum;
    }
    if (maxDiff < convergenceTolerance) break;
  }
  Object.assign(epvTable, V);
}

// ---------------------------------------------------------------------------
// Commentary (§43)
// ---------------------------------------------------------------------------

function commentaryFor(eng: Engine, before: MatchZone, after: MatchZone, note: string | null): void {
  const beforeV = epvTable[`${eng.phase}.${before}`] ?? 0.05;
  const afterV = epvTable[`${phaseForZone(after)}.${after}`] ?? 0.05;
  const delta = Math.abs(afterV - beforeV);
  const threshold = MS.commentary.deltaVPercentileThreshold;
  const show = delta >= threshold * 0.08 || note !== null;
  if (show) {
    const sideName = eng.possessionSide === 0 ? sideOf(eng, 0).club.name : sideOf(eng, 1).club.name;
    const text = note ?? `${sideName} advance into ${after.replace("_", " ").toLowerCase()}`;
    eng.commentary.push(text);
  }
}

// ---------------------------------------------------------------------------
// Main possession step
// ---------------------------------------------------------------------------

function stepPossession(eng: Engine): void {
  // Reset transition window when the possession ages past its window.
  if (eng.phase === "SET_PIECE" && eng.possessionAgeSeconds > MS.phaseWindows.setPieceMaxAgeSeconds) {
    eng.phase = phaseForZone(eng.zone);
  }
  if (eng.phase === "TRANSITION" && eng.possessionAgeSeconds > MS.phaseWindows.transitionMaxAgeSeconds) {
    eng.phase = phaseForZone(eng.zone);
    eng.isCounter = false;
  }

  // If a possession-start pinned a first action, use it (including failures).
  let action: string | null = eng.pendingFirstAction;
  eng.pendingFirstAction = null;

  if (!action) {
    const failure = controlFailureStep(eng);
    action = failure ?? selectIntentionalAction(eng);
  }
  // Client ball choreography snapshot: what this step attempted and where the
  // ball was when it started (before the outcome below moves zone/possession).
  eng.lastAction = action;
  eng.prevZone = eng.zone;
  const actionSide = eng.possessionSide;
  const actionZone = eng.zone;
  const ballAction = startBallAction(eng, action, actionSide, actionZone);
  // Stats counting
  const attSide = eng.possessionSide;
  const stats = eng.stats[attSide === 0 ? "home" : "away"];
  if (action === "PASS") stats.passes++;
  else if (action === "CROSS") stats.crosses++;
  else if (action === "CARRY") stats.carries++;
  else if (action === "DRIBBLE") stats.dribbles++;

  const actionPhase = eng.phase;
  const dt = controlledDuration(eng, action, actionPhase, eng.zone);
  eng.clockSeconds += dt;
  eng.possessionAgeSeconds += dt;
  eng.controlledSeconds[attSide] += dt;
  eng.controlledOnlySeconds += dt;
  eng.actions++;
  eng.actionCounts[action] = (eng.actionCounts[action] ?? 0) + 1;
  eng.phaseResidenceSeconds[actionPhase] += dt;
  if (LONG_RANK[eng.zone] >= 2) eng.attThirdSeconds[attSide] += dt;

  // Fatigue uses actual match-clock progress.
  fatigueEnergyLoss(eng, eng.home, dt);
  fatigueEnergyLoss(eng, eng.away, dt);
  updateOrganisation(eng, dt);

  // Minutes bookkeeping (approx: match-clock seconds → display minutes).
  eng.playerMinutes = eng.playerMinutes || {};
  for (const ps of sideOf(eng, attSide).on) {
    eng.playerMinutes[ps.id] = (eng.playerMinutes[ps.id] ?? 0) + dt / 60;
  }

  // Rating-only seconds counter (plan §17 §12): the observer tracks each
  // on-pitch player's seconds per fine role for the 10-minute rule and role
  // durations. BOTH sides' on-pitch players accumulate the same match-clock
  // seconds per step (the defending side plays the same dt). Read-only; never
  // affects gameplay.
  observeRatingSeconds(eng, dt);

  // Ensure stoppage is frozen as soon as we enter it so the very first
  // stoppage event is stamped with 45+ / 90+ correctly.
  if (eng.clockSeconds >= MS.timing.firstHalfEndSeconds && (eng.st.firstHalfAddedMinutes ?? 0) === 0) {
    ensureStoppageComputed(eng);
  }
  if (eng.clockSeconds >= MS.timing.regulationSeconds && (eng.st.secondHalfAddedMinutes ?? 0) === 0) {
    ensureStoppageComputed(eng);
  }
  const clockInfo = displayMinuteForClock(eng, eng.clockSeconds);
  const displayMinute = clockInfo.minute;
  const displayAddedTime = clockInfo.addedTime;

  // SHOT resolution
  if (action === "SHOT") {
    const eventHalf = eng.period as number;
    // Shots have no foul outcome; evaluate the hazard with the modeled action
    // factor right before the shot resolves.
    resolveInjuryHazard(eng, "SHOT", displayMinute, displayAddedTime);
    const def = opp(eng, attSide);
    const result = resolveShot(eng, sideOf(eng, attSide), def);
    const shotGk = def.on.find((ps) => ps.deployedRole === "GK") ?? null;
    ballAction.fromPlayerId = result.shooter?.id ?? ballAction.fromPlayerId;
    ballAction.targetPlayerId = result.saved ? shotGk?.id ?? null : null;
    stats.shots++;
    stats.xG += result.finalXg;
    if (result.onTarget) stats.shotsOnTarget++;
    if (result.goal) {
      finishBallAction(ballAction, { outcome: "GOAL", toZone: null, targetPlayerId: null });
      const club = sideOf(eng, attSide).club;
      eng.scores[attSide]++;
      // Assist attribution: the passer of the last completed PASS/CROSS of
      // this possession, when he is a teammate other than the scorer. Derived
      // from already-resolved presentation state — no RNG draws, no rule
      // change. Null after turnovers/restarts, so penalties and direct
      // free kicks never credit an assist.
      const assistId = result.shooter && eng.lastPasserSide === attSide && eng.lastPasserId !== null && eng.lastPasserId !== result.shooter.id
        ? eng.lastPasserId
        : null;
      eng.events.push({
        minute: displayMinute, half: eventHalf, type: EVENT_CODES.GOAL, subtype: GOAL_SUBTYPES.NORMAL,
        clubId: club.id, playerId: result.shooter?.id ?? null, player2Id: assistId, goalType: GOAL_SUBTYPES.NORMAL,
        ...(displayAddedTime !== undefined ? { addedTime: displayAddedTime } : {}),
      });
      // Goal/assist attribution: the scorer and assister are recorded in the
      // GOAL event above. The engine deliberately does NOT increment the live
      // Player counters here — a live tick persists only the match state, so an
      // in-memory Player mutation would be silently lost on the next reload.
      // Goals and assists are credited to the authoritative Player rows from
      // these events at the match boundary (applyMatchGoalsToPlayers from
      // applyMatchToPlayers at live full-time and from simulateMatch for
      // instant simulation).
      eng.commentary.push(`${result.shooter ? sideOf(eng, attSide).club.name : ""} score`);
      // KICK_OFF for opponent
      eng.possessionSide = attSide === 0 ? 1 : 0;
      beginPossession(eng, "KICK_OFF");
      return;
    }
    // Curated timeline events for non-goal shots: every attempt emits exactly
    // one event so the feed reconciles with the stat counters — goals + saves
    // + on-target woodwork = shotsOnTarget, and all five shot-outcome codes
    // together = shots. A save credits the defending goalkeeper with the
    // shooter as the secondary player ("GK saved shot by shooter" in the
    // feed); WOODWORK stays attributed to the shooter who hit it (subtype 1
    // marks an on-target hit); SHOT_MISS/SHOT_BLOCKED name the shooter, with
    // the blocker credited as the secondary player of SHOT_BLOCKED. REBOUND
    // never reaches here alone: a save-rebound also sets `saved`, so it is
    // recorded as a SAVE.
    if (!result.goal) {
      const shotClubId = sideOf(eng, attSide).club.id;
      if (result.saved) {
        const gk = shotGk;
        eng.events.push({
          minute: displayMinute, half: eventHalf,
          type: EVENT_CODES.SAVE,
          subtype: 0,
          clubId: def.club.id,
          playerId: gk?.id ?? null,
          player2Id: result.shooter?.id ?? null,
          goalType: 0,
          ...(displayAddedTime !== undefined ? { addedTime: displayAddedTime } : {}),
        });
      } else if (result.blocked) {
        eng.events.push({
          minute: displayMinute, half: eventHalf,
          type: EVENT_CODES.SHOT_BLOCKED,
          subtype: 0,
          clubId: shotClubId,
          playerId: result.shooter?.id ?? null,
          player2Id: result.blockerId,
          goalType: 0,
          ...(displayAddedTime !== undefined ? { addedTime: displayAddedTime } : {}),
        });
      } else if (result.woodwork) {
        eng.events.push({
          minute: displayMinute, half: eventHalf,
          type: EVENT_CODES.WOODWORK,
          subtype: result.onTarget ? 1 : 0,
          clubId: shotClubId,
          playerId: result.shooter?.id ?? null,
          player2Id: null,
          goalType: 0,
          ...(displayAddedTime !== undefined ? { addedTime: displayAddedTime } : {}),
        });
      } else {
        eng.events.push({
          minute: displayMinute, half: eventHalf,
          type: EVENT_CODES.SHOT_MISS,
          subtype: 0,
          clubId: shotClubId,
          playerId: result.shooter?.id ?? null,
          player2Id: null,
          goalType: 0,
          ...(displayAddedTime !== undefined ? { addedTime: displayAddedTime } : {}),
        });
      }
    }
    // Non-goal shot resolution
    if (result.saved) {
      finishBallAction(ballAction, { outcome: "SAVE", toZone: null, targetPlayerId: shotGk?.id ?? null });
      // Goalkeeper begins possession.
      eng.possessionSide = attSide === 0 ? 1 : 0;
      beginPossession(eng, null);
      eng.ballCarrierId = shotGk?.id ?? eng.ballCarrierId;
      ballAction.toZone = eng.zone;
      return;
    }
    if (result.blocked) {
      finishBallAction(ballAction, { outcome: "BLOCKED", toZone: null });
      // Live second ball — new possession, possible corner.
      eng.possessionSide = attSide === 0 ? 1 : 0;
      beginPossession(eng, null);
      ballAction.toZone = eng.zone;
      return;
    }
    if (result.rebound) {
      finishBallAction(ballAction, { outcome: "REBOUND", toZone: "BOX", targetPlayerId: result.shooter?.id ?? null });
      // Rebound returns to BOX/ATT_CENTRAL for the same team.
      eng.zone = "BOX";
      eng.lane = "CENTRE";
      eng.phase = "FINAL_THIRD";
      eng.ballCarrierId = result.shooter?.id ?? presentationPlayerId(sideOf(eng, attSide), eng.zone);
      ballAction.toZone = eng.zone;
      return;
    }
    if (result.woodwork) {
      finishBallAction(ballAction, { outcome: "WOODWORK", toZone: null });
      // Play continues — reset to a defensive restart.
      eng.possessionSide = attSide === 0 ? 1 : 0;
      beginPossession(eng, null);
      ballAction.toZone = eng.zone;
      return;
    }
    // On-target save (controlled) handled above; a miss with no on-target = GK restart.
    finishBallAction(ballAction, { outcome: "MISS", toZone: null });
    eng.possessionSide = attSide === 0 ? 1 : 0;
    beginPossession(eng, null);
    ballAction.toZone = eng.zone;
    return;
  }

  // Non-shot: resolve outcome
  const outcome = resolveOutcome(eng, action);
  // Spec §13.5: a FOUL outcome carries the FOUL action factor; every other
  // non-shot action uses its modeled/failure factor. The hazard must run after
  // the outcome is known but before the outcome's consequences (so an injured
  // defender can no longer be selected as the fouler).
  resolveInjuryHazard(eng, outcome === "FOUL" ? "FOUL" : action, displayMinute, displayAddedTime);

  if (outcome === "CONTINUE") {
    const beforeZone = eng.zone;
    const nextZone = pickNextZone(eng, action);
    // Lane selection
    eng.lane = destinationLaneFor(eng, nextZone);
    const mappedZone = zoneLane(nextZone, eng.lane);
    if (mappedZone !== eng.zone) {
      commentaryFor(eng, beforeZone, mappedZone, null);
    }
    eng.zone = mappedZone;
    eng.phase = phaseForZone(mappedZone);
    if (LONG_RANK[mappedZone] >= 2 && eng.possessionHighRecovery === false) {
      // high recovery already tracked at possession start
    }
    if (mappedZone === "BOX") stats.boxEntries++;
    const nextCarrierId = action === "CARRY" || action === "DRIBBLE"
      ? ballAction.fromPlayerId
      : presentationPlayerId(sideOf(eng, attSide), mappedZone, ballAction.fromPlayerId);
    eng.ballCarrierId = nextCarrierId;
    // A completed pass/cross arms the assist window: its passer can assist the
    // next goal of this possession. Carries/dribbles keep the window open.
    if (action === "PASS" || action === "CROSS") {
      eng.lastPasserId = ballAction.fromPlayerId;
      eng.lastPasserSide = attSide;
    }
    finishBallAction(ballAction, { outcome: "CONTINUE", toZone: mappedZone, targetPlayerId: nextCarrierId });
    return;
  }

  if (outcome === "TURNOVER") {
    stats.turnovers++;
    // High recovery if turnover happens in the opponent's half (advanced zone).
    if (LONG_RANK[eng.zone] >= 1) {
      const newSide = eng.possessionSide === 0 ? 1 : 0;
      eng.stats[newSide === 0 ? "home" : "away"].highRecoveries++;
    }
    // Live turnover → switch possession, mirror lane, no dead-ball delay.
    eng.possessionSide = attSide === 0 ? 1 : 0;
    // Possession changed hands without a restart: the previous passer cannot
    // assist against his own team.
    eng.lastPasserId = null;
    eng.lastPasserSide = null;
    eng.lane = mirrorLane(eng.lane);
    eng.possessionAgeSeconds = 0;
    const interceptorId = presentationPlayerId(sideOf(eng, eng.possessionSide), eng.zone);
    eng.ballCarrierId = interceptorId;
    finishBallAction(ballAction, {
      outcome: "TURNOVER",
      toZone: eng.zone,
      interceptorId,
    });
    // Defensive organisation disruption for the newly-defending side.
    const newDef = opp(eng, eng.possessionSide);
    const { disruption, recoveryTime } = disruptionAfterTurnover(eng, newDef);
    newDef.organisationDisruption = disruption;
    newDef.organisationRecoveryTime = recoveryTime;
    // Counter activation.
    tryActivateCounter(eng);
    eng.possessionHighRecovery = true;
    eng.pendingFirstAction = null;
    return;
  }

  if (outcome === "FOUL") {
    const def = opp(eng, attSide);
    stats.fouls++;
    const fouler = selectFouler(eng, def);
    finishBallAction(ballAction, { outcome: "FOUL", foulerId: fouler.id });
    resolveCards(eng, fouler, def, displayMinute, displayAddedTime);
    // Same team keeps possession; restart.
    let restart: RestartType = "FREE_KICK";
    if (eng.zone === "BOX") {
      // Defending foul in BOX → penalty restart (penalty shot resolves via the
      // PENALTY possession start which pins SHOT as the first action).
      stats.penalties++;
      restart = "PENALTY";
    }
    beginPossession(eng, restart);
    eng.clockSeconds += MS.timing.deadBallSecondsPerRestart;
    eng.deadBallSeconds += MS.timing.deadBallSecondsPerRestart;
    observeRatingSeconds(eng, MS.timing.deadBallSecondsPerRestart);
    finishBallAction(ballAction, { toZone: eng.zone, targetPlayerId: eng.ballCarrierId });
    return;
  }

  // RETAINED_RESTART
  if (outcome === "RETAINED_RESTART") {
    const zone = eng.zone;
    const restartRow = MS.probabilityModel.restartTypeByZone[zone];
    const labels = Object.keys(restartRow);
    const weights = labels.map((l) => l === "CORNER"
      ? restartRow[l] * MS.probabilityModel.cornerRateCalibrationMultiplier
      : restartRow[l]);
    const restart = weightedPick(eng.rng, labels, weights) as RestartType;
    let restartCarrierId: number | null = null;
    if (restart === "CORNER") {
      stats.corners++;
      restartCarrierId = cornerTakerId(eng, attSide, stats.corners);
      // Curated timeline: corner awards mirror the stat counter exactly and
      // name a (deterministically chosen) taker for the feed.
      eng.events.push({
        minute: displayMinute, half: eng.period as number, type: EVENT_CODES.CORNER, subtype: 0,
        clubId: sideOf(eng, attSide).club.id, playerId: restartCarrierId, player2Id: null, goalType: 0,
        ...(displayAddedTime !== undefined ? { addedTime: displayAddedTime } : {}),
      });
    }
    if (restart === "THROW_IN" || restart === "FREE_KICK" || restart === "GOAL_KICK" || restart === "CORNER") {
      eng.clockSeconds += MS.timing.deadBallSecondsPerRestart;
      eng.deadBallSeconds += MS.timing.deadBallSecondsPerRestart;
      observeRatingSeconds(eng, MS.timing.deadBallSecondsPerRestart);
    }
    beginPossession(eng, restart, false, restartCarrierId);
    finishBallAction(ballAction, { outcome: "RETAINED_RESTART", toZone: eng.zone, targetPlayerId: eng.ballCarrierId });
    return;
  }
}

// ---------------------------------------------------------------------------
// Match run loop
// ---------------------------------------------------------------------------

function periodEndSeconds(eng: Engine): number {
  if (eng.period === 1) {
    const added = eng.st.firstHalfAddedMinutes ?? 0;
    return MS.timing.firstHalfEndSeconds + added * 60;
  }
  const firstAdded = eng.st.firstHalfAddedMinutes ?? 0;
  const secondAdded = eng.st.secondHalfAddedMinutes ?? 0;
  return MS.timing.regulationSeconds + (firstAdded + secondAdded) * 60;
}

// ---------------------------------------------------------------------------
// Boundary timeline events
//
// Whistles/announcements are synthesized once per structural transition. They
// must never consume RNG draws (outcome neutrality) and must be idempotent:
// a live state paused at half-time is rebuilt from `st` on resume, and
// `st.events` is shared with the engine, so existence checks against the
// persisted event list guard against double emission across reloads.
// ---------------------------------------------------------------------------

function hasEvent(eng: Engine, type: number): boolean {
  return eng.events.some((e) => e.type === type);
}

function pushBoundaryEvent(eng: Engine, type: number, minute: number, addedMinutes: number): void {
  if (hasEvent(eng, type)) return;
  eng.events.push({
    minute,
    half: eng.period === 2 ? 2 : 1,
    type,
    subtype: 0,
    clubId: eng.home.club.id,
    playerId: null,
    player2Id: null,
    goalType: 0,
    ...(addedMinutes > 0 ? { addedTime: addedMinutes } : {}),
  });
}

/** End of the first half ("45+X'"), emitted when the clock first reaches the
 *  first-half boundary — including the pause path for human broadcasts. */
function pushHalfTimeWhistle(eng: Engine): void {
  pushBoundaryEvent(eng, EVENT_CODES.HALF_TIME, 45, eng.st.firstHalfAddedMinutes ?? 0);
}

/** Start of the second half (display minute 46). Emitted at the period flip. */
function pushSecondHalfKickoff(eng: Engine): void {
  const disp = displayMinuteForClock(eng, eng.clockSeconds);
  pushBoundaryEvent(eng, EVENT_CODES.SECOND_HALF_START, disp.minute, 0);
}

/** A drawn decider goes straight to penalties from full time in this engine
 *  (no played extra-time periods); announce before the shootout kicks. */
function pushShootoutAnnouncement(eng: Engine): void {
  pushBoundaryEvent(eng, EVENT_CODES.SHOOTOUT, 90, eng.st.secondHalfAddedMinutes ?? 0);
}

/** Full time ("90+X'"). Emitted on both ended=true paths of runMatch. */
function pushFullTimeWhistle(eng: Engine): void {
  pushBoundaryEvent(eng, EVENT_CODES.FULL_TIME, 90, eng.st.secondHalfAddedMinutes ?? 0);
}

/**
 * Deterministic corner-taker attribution for the event feed — never consumes
 * RNG draws, so match outcomes stay untouched. Prefers wide/advanced roles,
 * falling back to any outfielder, cycling by the team's corner ordinal so
 * repeated corners rotate plausible takers within a match.
 */
function cornerTakerId(eng: Engine, attSide: 0 | 1, cornerOrdinal: number): number | null {
  const outfield = sideOf(eng, attSide).on.filter((ps) => ps.deployedRole !== "GK");
  if (outfield.length === 0) return null;
  const preferred = outfield.filter((ps) => ["LW", "RW", "ST"].includes(ps.deployedRole));
  const pool = preferred.length > 0 ? preferred : outfield;
  return pool[(cornerOrdinal - 1) % pool.length].id;
}

function runMatch(eng: Engine, targetClockSeconds?: number, opts?: { pauseAtHalftime?: boolean }): void {
  let guard = 0;
  while (!eng.ended && guard++ < 500000) {
    // Freeze stoppage as soon as we reach the raw boundary so the added window is known before stepping into it.
    ensureStoppageComputed(eng);
    const boundary = periodEndSeconds(eng);
    if (eng.clockSeconds >= boundary) {
      if (eng.period === 1) {
        pushHalfTimeWhistle(eng);
        if (opts?.pauseAtHalftime) {
          break;
        }
        // Switch possession to the coin-toss loser for the second half kickoff (winner chose first half).
        eng.period = 2;
        const winner = (eng.st.coinTossWinner ?? 0) as 0 | 1;
        eng.possessionSide = winner === 0 ? 1 : 0;
        eng.st.withBall = eng.possessionSide;
        beginPossession(eng, "KICK_OFF");
        pushSecondHalfKickoff(eng);
        continue;
      }
      if (eng.st.decider && eng.scores[0] === eng.scores[1] && !eng.extraTimePlayed) {
        eng.extraTimePlayed = true;
        pushShootoutAnnouncement(eng);
        doShootout(eng);
      }
      pushFullTimeWhistle(eng);
      eng.ended = true;
      break;
    }
    // Respect explicit target (live tick) after resolving any boundary that
    // the preceding action crossed. Instant runs do the same boundary work on
    // their next loop; checking the target first would defer a half/full-time
    // transition and consume a different subsequent RNG path.
    if (targetClockSeconds !== undefined && eng.clockSeconds >= targetClockSeconds) break;
    evaluateAiSubstitutions(eng);
    stepPossession(eng);
  }
  const totalEnd = MS.timing.regulationSeconds + (eng.st.firstHalfAddedMinutes ?? 0) * 60 + (eng.st.secondHalfAddedMinutes ?? 0) * 60;
  if (!eng.ended && eng.clockSeconds >= totalEnd) {
    if (eng.st.decider && eng.scores[0] === eng.scores[1] && !eng.extraTimePlayed) {
      eng.extraTimePlayed = true;
      pushShootoutAnnouncement(eng);
      doShootout(eng);
    }
    pushFullTimeWhistle(eng);
    eng.ended = true;
  }
}

/** Move the designated taker (if he's on the pitch) to the front of the
 *  kicking order — real-world convention is the best/preferred taker goes
 *  first. Draw count per kick is unchanged (still one nextDouble each), so
 *  this reorder cannot shift the RNG stream or calibration. */
function orderedShootoutTakers(outfielders: LivePlayerState[], designatedId: number | null): LivePlayerState[] {
  if (designatedId === null) return outfielders;
  const idx = outfielders.findIndex((ps) => ps.id === designatedId);
  if (idx <= 0) return outfielders;
  const reordered = outfielders.slice();
  const [taker] = reordered.splice(idx, 1);
  reordered.unshift(taker);
  return reordered;
}

function doShootout(eng: Engine): void {
  // Honour a designated penalty taker (Club.penaltyTakerId, or a live-only
  // SET_TAKER automation override, plan §11) the same way in-play penalties
  // do — see resolveShot's PENALTY branch.
  const homeTakerId = eng.st.livePenaltyTakerId?.[0] ?? eng.home.club.penaltyTakerId ?? null;
  const awayTakerId = eng.st.livePenaltyTakerId?.[1] ?? eng.away.club.penaltyTakerId ?? null;
  const takers: LivePlayerState[][] = [
    orderedShootoutTakers(eng.home.on.filter((ps) => ps.deployedRole !== "GK"), homeTakerId),
    orderedShootoutTakers(eng.away.on.filter((ps) => ps.deployedRole !== "GK"), awayTakerId),
  ];
  const scores = [0, 0];
  const doKick = (side: 0 | 1, kick: number) => {
    const list = takers[side];
    if (list.length === 0) return;
    const taker = list[Math.min(kick, list.length - 1)];
    const scored = nextDouble(eng.rng) < 0.76;
    if (scored) scores[side]++;
    const club = side === 0 ? eng.home.club : eng.away.club;
    eng.events.push({
      minute: 120 + kick, half: 2, type: scored ? EVENT_CODES.GOAL : EVENT_CODES.MISSED_PENALTY, subtype: GOAL_SUBTYPES.PENALTY,
      clubId: club.id, playerId: taker.id, player2Id: null, goalType: GOAL_SUBTYPES.PENALTY,
    });
  };
  let kick = 0;
  for (let round = 0; round < 5; round++) {
    doKick(0, kick);
    doKick(1, kick);
    kick++;
  }
  while (scores[0] === scores[1]) {
    doKick(0, kick);
    doKick(1, kick);
    kick++;
  }
  eng.shootout = { scores: [scores[0], scores[1]], winner: scores[0] > scores[1] ? eng.home.club.id : eng.away.club.id };
}

// ---------------------------------------------------------------------------
// Public engine entrypoints
// ---------------------------------------------------------------------------

function buildEngine(
  rng: RngState,
  home: Club,
  away: Club,
  players: Player[],
  st: LiveMatchState,
  centers: AttributeCenters,
  ratingObserver?: RatingObserver
): Engine {
  // The engine's authoritative RNG stream is the persisted state stream, so a
  // live match resumes deterministically after a reload; `rng` is only the
  // fallback for states created before the stream field existed.
  const engineRng = st.rngState ?? { seed: rng.seed, state: rng.state };
  const playersById = playerIndexFor(players);
  const resolve = (ids: number[]) => ids.map((id) => playersById.get(id)).filter((p): p is Player => !!p);
  st.playerEnergy ??= {};
  const homeXI = resolve(st.homeOn);
  const awayXI = resolve(st.awayOn);
  const quality = qualityCompensation(players, new Set([home.id, away.id]), [...st.homeXI, ...st.awayXI]);

  // §9.1: resolve each on-pitch player's deployed role from the side's current
  // formation plus his live slot map entry; never inspect natural position for
  // zone support.
  const homeSideState = (p: Player) => {
    const { role, slotIndex } = deployedRoleForSlot(st.homeSlotByPlayerId, st.homeTactics.formation, p.id);
    return buildPlayerState(p, centers, role, slotIndex, st.playerEnergy[p.id] ?? p.energy);
  };
  const awaySideState = (p: Player) => {
    const { role, slotIndex } = deployedRoleForSlot(st.awaySlotByPlayerId, st.awayTactics.formation, p.id);
    return buildPlayerState(p, centers, role, slotIndex, st.playerEnergy[p.id] ?? p.energy);
  };

  const homeSide: Side = {
    idx: 0,
    club: home,
    on: homeXI.map(homeSideState),
    bench: resolve(st.homeSubs),
    tactics: st.homeTactics,
    support: { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 },
    coverage: { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 },
    expectedSupport: expectedSupport(st.homeTactics.formation),
    expectedSupportTotal: 0,
    organisation: 0,
    baselineOrganisation: 0,
    organisationDisruption: 0,
    organisationRecoveryTime: 1,
    cachedBaselineOrganisation: 0,
    rosterVersion: 0,
    involvedCache: {},
    involvedIdCache: {},
  };
  const awaySide: Side = {
    idx: 1,
    club: away,
    on: awayXI.map(awaySideState),
    bench: resolve(st.awaySubs),
    tactics: st.awayTactics,
    support: { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 },
    coverage: { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 },
    expectedSupport: expectedSupport(st.awayTactics.formation),
    expectedSupportTotal: 0,
    organisation: 0,
    baselineOrganisation: 0,
    organisationDisruption: 0,
    organisationRecoveryTime: 1,
    cachedBaselineOrganisation: 0,
    rosterVersion: 0,
    involvedCache: {},
    involvedIdCache: {},
  };
  for (const side of [homeSide, awaySide]) {
    side.expectedSupportTotal = ZONES.reduce((s, z) => s + (side.expectedSupport[z] ?? 0), 0) || 7;
    computeSupport(side);
  }
  const hasPersistedOrganisation = st.matchClockSeconds > 0 || st.events.some((e) => e.type !== EVENT_CODES.COIN_TOSS);
  homeSide.baselineOrganisation = hasPersistedOrganisation && st.homeBaselineOrganisation > 0
    ? st.homeBaselineOrganisation
    : homeSide.cachedBaselineOrganisation;
  awaySide.baselineOrganisation = hasPersistedOrganisation && st.awayBaselineOrganisation > 0
    ? st.awayBaselineOrganisation
    : awaySide.cachedBaselineOrganisation;
  homeSide.organisation = hasPersistedOrganisation && st.homeDefensiveOrganisation > 0
    ? st.homeDefensiveOrganisation
    : homeSide.baselineOrganisation;
  awaySide.organisation = hasPersistedOrganisation && st.awayDefensiveOrganisation > 0
    ? st.awayDefensiveOrganisation
    : awaySide.baselineOrganisation;
  homeSide.organisationDisruption = Math.max(0, homeSide.baselineOrganisation - homeSide.organisation);
  awaySide.organisationDisruption = Math.max(0, awaySide.baselineOrganisation - awaySide.organisation);
  homeSide.organisationRecoveryTime = st.homeOrganisationRecoveryTime > 0 ? st.homeOrganisationRecoveryTime : 1;
  awaySide.organisationRecoveryTime = st.awayOrganisationRecoveryTime > 0 ? st.awayOrganisationRecoveryTime : 1;

  const eng: Engine = {
    rng: engineRng,
    st,
    home: homeSide,
    away: awaySide,
    ratingObserver,
    possessionSide: (st.withBall as 0 | 1) ?? 0,
    phase: (st.phase as MatchPhase) ?? "BUILD_UP",
    zone: (st.zone as MatchZone) ?? "DEF_CENTRAL",
    lane: (st.lane as Lane) ?? "CENTRE",
    possessionStartType: st.possessionStartType ?? "OPEN_PLAY",
    possessionAgeSeconds: st.possessionAgeSeconds ?? 0,
    pendingFirstAction: st.possessionFirstAction ?? null,
    clockSeconds: st.matchClockSeconds ?? 0,
    period: (st.period as 1 | 2) ?? 1,
    controlledSeconds: [st.controlledBallSeconds?.[0] ?? 0, st.controlledBallSeconds?.[1] ?? 0],
    attThirdSeconds: [st.attackingThirdControlledSeconds?.[0] ?? 0, st.attackingThirdControlledSeconds?.[1] ?? 0],
    stats: {
      home: { ...emptyStats(), ...(st.teamStats?.home ?? {}) },
      away: { ...emptyStats(), ...(st.teamStats?.away ?? {}) },
    },
    cards: st.cards ?? [],
    injuries: st.injuries ?? [],
    substitutions: st.substitutions ?? [],
    events: st.events,
    isCounter: st.isCounter ?? false,
    lastAction: st.lastAction ?? null,
    prevZone: st.prevZone ?? null,
    ballCarrierId: st.ballCarrierId != null && (st.withBall === 0 ? homeXI : awayXI).some((p) => p.id === st.ballCarrierId)
      ? st.ballCarrierId
      : null,
    // Assist window survives streamed ticks so a goal right after a resume is
    // still credited to the possession's passer.
    lastPasserId: st.lastPasserId ?? null,
    lastPasserSide: st.lastPasserSide ?? null,
    ballActionSequence: st.ballActionSequence ?? 0,
    lastBallAction: st.lastBallAction ? { ...st.lastBallAction } : null,
    possessionHighRecovery: st.possessionHighRecovery ?? false,
    opponentControlSeconds: st.opponentControlSeconds ?? [0, 0],
    pressureAdvancedStates: st.pressureWindowAdvancedStates ?? [0, 0],
    pressureWindowStart: st.pressureWindowStartSeconds ?? [0, 0],
    onPitchBySide: [homeXI, awayXI],
    centers,
    homeOn: homeXI,
    awayOn: awayXI,
    playerMinutes: { ...(st.playerMinutes ?? {}) },
    playerRecentLoad: { ...(st.playerRecentLoad ?? {}) },
    playerMatchLoad: { ...(st.playerMatchLoad ?? {}) },
    aiSubLastMinute: [...(st.aiSubLastMinute ?? [-1, -1])],
    ratingSecondsRosterKey: "",
    ratingSecondsEntries: [],
    commentary: [],
    ended: st.ended ?? false,
    extraTimePlayed: st.extraTimePlayed ?? false,
    shootout: st.shootout ?? null,
    playerYellows: { ...(st.playerYellows ?? {}) },
    scores: [...(st.scores ?? [0, 0])] as [number, number],
    deadBallSeconds: 0,
    controlledOnlySeconds: 0,
    actions: 0,
    actionCounts: {},
    phaseResidenceSeconds: {
      SET_PIECE: 0,
      TRANSITION: 0,
      BUILD_UP: 0,
      PROGRESSION: 0,
      FINAL_THIRD: 0,
    },
    restartCounts: {},
    possessionStarts: 0,
    passIntentScale: quality.passIntentScale,
    tempoScale: quality.tempoScale,
  };

  // Initial possession
  // Only a brand-new match starts a fresh possession; a resumed live state
  // continues from its persisted zone/phase/lane.
  if (eng.clockSeconds <= 0) {
    beginPossession(eng, "KICK_OFF");
  } else if (eng.ballCarrierId === null) {
    eng.ballCarrierId = presentationPlayerId(sideOf(eng, eng.possessionSide), eng.zone, null, eng.possessionStartType === "GOAL_KICK");
  }

  computeEpv();
  return eng;
}

function emptyStats(): TeamMatchStats {
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

export function simulatePossessionMatch(
  rng: RngState,
  home: Club,
  away: Club,
  players: Player[],
  st: LiveMatchState,
  centers: AttributeCenters,
  targetSeconds?: number,
  diagnosticsOut?: MatchSimulationDiagnostics,
  ratingObserver?: RatingObserver
): void {
  const eng = buildEngine(rng, home, away, players, st, centers, ratingObserver);
  // Instant/streamed equivalence (§22.2): an unchunked run must flip the period
  // at the SAME clock the streamed path does. A single runMatch call with no
  // target keeps processing first-half actions past the boundary before the
  // loop-top check flips the period, which the chunked path never does.
  // Chunk the instant run at the first-half boundary so both paths agree.
  const firstBoundary = MS.timing.firstHalfEndSeconds + (st.firstHalfAddedMinutes ?? 0) * 60;
  const chunkAtFirstHalf = targetSeconds === undefined && !eng.ended && eng.period === 1 && eng.clockSeconds < firstBoundary;
  if (chunkAtFirstHalf) {
    runMatch(eng, firstBoundary);
    // If the boundary was reached, the next call continues in period 2.
  }
  runMatch(eng, targetSeconds);
  writeBack(eng, st, diagnosticsOut);
}

/** Advance a live match by `matchMinutes` (converted to match-clock seconds). */
export function advancePossessionMatch(
  rng: RngState,
  home: Club,
  away: Club,
  players: Player[],
  st: LiveMatchState,
  matchMinutes: number,
  centers: AttributeCenters,
  opts?: { pauseAtHalftime?: boolean; ratingObserver?: RatingObserver }
): void {
  const eng = buildEngine(rng, home, away, players, st, centers, opts?.ratingObserver);
  const startClock = eng.clockSeconds;
  const firstAdded = st.firstHalfAddedMinutes ?? 0;
  const secondAdded = st.secondHalfAddedMinutes ?? 0;
  const dynamicEnd = MS.timing.regulationSeconds + (firstAdded + secondAdded) * 60;
  const target = Math.min(dynamicEnd, startClock + matchMinutes * 60);
  runMatch(eng, target, opts);
  writeBack(eng, st);
}

function writeBack(eng: Engine, st: LiveMatchState, diagnosticsOut?: MatchSimulationDiagnostics): void {
  st.matchClockSeconds = eng.clockSeconds;
  st.period = eng.period;
  st.phase = eng.phase;
  st.zone = eng.zone;
  st.lane = eng.lane;
  st.possessionStartType = eng.possessionStartType;
  st.possessionAgeSeconds = eng.possessionAgeSeconds;
  st.homeDefensiveOrganisation = eng.home.organisation;
  st.awayDefensiveOrganisation = eng.away.organisation;
  st.homeBaselineOrganisation = eng.home.baselineOrganisation;
  st.awayBaselineOrganisation = eng.away.baselineOrganisation;
  st.homeOrganisationRecoveryTime = eng.home.organisationRecoveryTime;
  st.awayOrganisationRecoveryTime = eng.away.organisationRecoveryTime;
  st.controlledBallSeconds = eng.controlledSeconds;
  st.attackingThirdControlledSeconds = eng.attThirdSeconds;
  st.cards = eng.cards;
  st.injuries = eng.injuries;
  st.substitutions = eng.substitutions;
  // Report controlled-ball seconds in the team stats before copying the live
  // view; otherwise the API would expose 0/0 possession until full-time even
  // though the engine accumulates the values correctly.
  eng.stats.home.controlledBallSeconds = eng.controlledSeconds[0];
  eng.stats.away.controlledBallSeconds = eng.controlledSeconds[1];
  eng.stats.home.attackingThirdControlledSeconds = eng.attThirdSeconds[0];
  eng.stats.away.attackingThirdControlledSeconds = eng.attThirdSeconds[1];
  st.teamStats = eng.stats;
  st.stats = { home: { ...eng.stats.home }, away: { ...eng.stats.away } };
  st.isCounter = eng.isCounter;
  st.possessionHighRecovery = eng.possessionHighRecovery;
  st.lastAction = eng.lastAction;
  st.prevZone = eng.prevZone;
  st.ballCarrierId = eng.ballCarrierId;
  st.lastPasserId = eng.lastPasserId;
  st.lastPasserSide = eng.lastPasserSide;
  st.ballActionSequence = eng.ballActionSequence;
  st.lastBallAction = eng.lastBallAction ? { ...eng.lastBallAction } : null;
  st.opponentControlSeconds = eng.opponentControlSeconds;
  st.pressureWindowAdvancedStates = eng.pressureAdvancedStates;
  st.pressureWindowStartSeconds = eng.pressureWindowStart;
  st.rngState = { ...eng.rng };
  st.ended = eng.ended;
  st.extraTimePlayed = eng.extraTimePlayed;
  st.shootout = eng.shootout ?? st.shootout;
  if (diagnosticsOut) {
    diagnosticsOut.actionCounts = { ...eng.actionCounts };
    diagnosticsOut.phaseResidenceSeconds = { ...eng.phaseResidenceSeconds };
    diagnosticsOut.restartCounts = { ...eng.restartCounts };
    diagnosticsOut.possessionStarts = eng.possessionStarts;
    diagnosticsOut.deadBallSeconds = eng.deadBallSeconds;
    diagnosticsOut.controlledBallSeconds = [...eng.controlledSeconds] as [number, number];
  }
  st.playerYellows = eng.playerYellows;
  st.playerMinutes = eng.playerMinutes;
  st.playerEnergy ??= {};
  for (const side of [eng.home, eng.away]) {
    for (const ps of side.on) st.playerEnergy[ps.id] = ps.energy;
  }
  st.playerRecentLoad = { ...eng.playerRecentLoad };
  st.playerMatchLoad = { ...eng.playerMatchLoad };
  st.aiSubLastMinute = [...eng.aiSubLastMinute];
  st.homeOn = eng.home.on.map((ps) => ps.id);
  st.awayOn = eng.away.on.map((ps) => ps.id);
  st.scores = eng.scores;
  st.withBall = eng.possessionSide;
  st.possessionFirstAction = eng.pendingFirstAction;
  // Persist added-time values (they are computed lazily inside the engine).
  st.firstHalfAddedMinutes = eng.st.firstHalfAddedMinutes ?? 0;
  st.secondHalfAddedMinutes = eng.st.secondHalfAddedMinutes ?? 0;
  // Display minute from match clock, with 45+/90+ stoppage handling.
  const firstEnd = MS.timing.firstHalfEndSeconds + (st.firstHalfAddedMinutes ?? 0) * 60;
  const atHalfTime = !eng.ended && !eng.extraTimePlayed && eng.clockSeconds >= firstEnd && eng.period === 1;
  if (atHalfTime) {
    st.minute = 0;
  } else {
    const disp = displayMinuteForClock(eng, eng.clockSeconds);
    st.minute = Math.min(120, disp.minute);
  }
  st.half = atHalfTime || eng.period === 2 ? 1 : 0;
}

/** Compute possession percentage from controlled seconds (plan §22). */
export function possessionPercent(controlledSeconds: [number, number]): [number, number] {
  const total = controlledSeconds[0] + controlledSeconds[1];
  if (total <= 0) return [50, 50];
  const home = Math.round((controlledSeconds[0] / total) * 100);
  return [home, 100 - home];
}

// Attribute centers are 16 sorts over the whole player population. Every match
// setup needs them twice (the engine's own normalization and the rating
// benchmarks), and every match of a game day computes the same answer. The key
// is the array reference plus the skills version, exactly as documented on
// `bumpSkillsVersion`: a push bumps the version, a reassignment changes the
// reference, and an in-place skill edit bumps the version.
let _centersPlayers: Player[] | null = null;
let _centersVersion = -1;
let _centers: AttributeCenters | null = null;

export function cachedAttributeCenters(players: Player[]): AttributeCenters {
  const version = currentSkillsVersion();
  if (_centers && _centersPlayers === players && _centersVersion === version) return _centers;
  _centers = computeAttributeCenters(players);
  _centersPlayers = players;
  _centersVersion = version;
  return _centers;
}

export function centersForWorld(world: World): AttributeCenters {
  // Skills and squad membership change during a season, so a seed-only cache
  // would silently normalize new ratings against stale player distributions.
  return computeAttributeCenters(world.players);
}
