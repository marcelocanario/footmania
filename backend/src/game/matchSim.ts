import type { Club, LiveBallAction, LiveCardState, LiveInjuryState, LiveMatchState, LiveSubstitutionState, LiveTactics, MatchEvent, MatchSimulationDiagnostics, Player, RngState, TeamMatchStats, World } from "./types";
import { MATCH_SIMULATOR_CONFIG as MS, INFLUENCE_SCALES } from "../matchSimulatorConfig";
import { nextDouble, nextInt, gamma } from "./rng";
import { EVENT_CODES, GOAL_SUBTYPES } from "./constants";
import { ENERGY_INJURY_MODEL, energyLoss, injuryRiskMultiplier, loadIncrement, physicalSkill, readiness, recordInjury } from "./energyInjury";
import { gameConfig, MP_CONFIG } from "../config";

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
  skills: { gol: number; vel: number; tec: number; pas: number; des: number; arm: number; fin: number };
  overall: number;
  age: number;
  position: number;
  tacPos: number;
  fit: number;
  energy: number;
  readiness: number;
  zTech: number;
  zPace: number;
  zPhysical: number;
  zFinishing: number;
  zGk: number;
  zDiscipline: number;
  onPitch: boolean;
}

export const ZONES: MatchZone[] = ["DEF_WIDE", "DEF_CENTRAL", "MID_WIDE", "MID_CENTRAL", "ATT_WIDE", "ATT_CENTRAL", "BOX"];
export const LANES: Lane[] = ["LEFT", "CENTRE", "RIGHT"];
export const INTENT_ACTIONS: IntentAction[] = ["PASS", "CROSS", "CARRY", "DRIBBLE", "SHOT", "CLEARANCE"];
export const FAILURE_ACTIONS: FailureAction[] = ["MISCONTROL", "DISPOSSESSED"];

const LONG_RANK: Record<MatchZone, number> = { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 1, MID_CENTRAL: 1, ATT_WIDE: 2, ATT_CENTRAL: 2, BOX: 3 };

// ---------------------------------------------------------------------------
// Canonical mapping: existing Player.skills -> engine canonical attributes.
// One adapter; the engine never reads raw skill fields directly.
// ---------------------------------------------------------------------------

const SKILL_MAP = {
  technical: "tech" as const,
  pace: "pace" as const,
  physical: "physical" as const,
  finishing: "finishing" as const,
  gk: "gk" as const,
  discipline: "discipline" as const,
};

function physicalOf(skills: { des: number; arm: number }): number {
  return (skills.des + skills.arm) / 2;
}

/** Position compatibility matrix (natural position 0..4 -> assigned tacPos). */
const COMPATIBILITY: Record<number, Record<number, number>> = {
  0: { 1: 1.0, 2: 0.0, 3: 0.0, 9: 0.0, 10: 0.0, 17: 0.0, 13: 0.0, 19: 0.0, 21: 0.0, 18: 0.0, 25: 0.0, 23: 0.0 },
  1: { 1: 0.2, 2: 1.0, 9: 1.0, 3: 0.75, 23: 0.7, 10: 0.6, 17: 0.6, 13: 0.5, 19: 0.5, 21: 0.5, 18: 0.4, 25: 0.4 },
  2: { 1: 0.15, 2: 0.7, 9: 0.7, 3: 1.0, 23: 0.95, 10: 0.45, 17: 0.45, 13: 0.6, 19: 0.4, 21: 0.4, 18: 0.5, 25: 0.5 },
  3: { 1: 0.1, 2: 0.55, 9: 0.55, 3: 0.55, 23: 0.55, 10: 0.95, 17: 0.95, 13: 1.0, 19: 0.8, 21: 0.8, 18: 0.8, 25: 0.75 },
  4: { 1: 0.05, 2: 0.4, 9: 0.4, 3: 0.35, 23: 0.35, 10: 0.7, 17: 0.7, 13: 0.65, 19: 0.95, 21: 0.95, 18: 1.0, 25: 1.0 },
};

export function positionFit(naturalPosition: number, tacPos: number): number {
  const row = COMPATIBILITY[naturalPosition];
  if (!row) return 0;
  return row[tacPos] ?? 0.5;
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
  const source: Record<string, (p: Player) => number> = {
    tec: (p) => p.skills.tec,
    vel: (p) => p.skills.vel,
    physical: (p) => physicalOf(p.skills),
    fin: (p) => p.skills.fin,
    gol: (p) => p.skills.gol,
    des: (p) => p.skills.des,
  };
  for (const key of Object.keys(source)) {
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

function tacPosRole(tacPos: number): string {
  if (tacPos === 1) return "GK";
  if (tacPos === 2) return "LB";
  if (tacPos === 9) return "RB";
  if (tacPos === 23) return "SW";
  if (tacPos === 19) return "LW";
  if (tacPos === 21) return "RW";
  if (tacPos === 10) return "LM";
  if (tacPos === 17) return "RM";
  if (tacPos === 18 || tacPos === 25) return "ST";
  if (tacPos >= 3 && tacPos <= 8) return "CB";
  return "CM";
}

/** Zone involvement weight for a player: their formation-support weight for the zone. */
function involvement(role: string, zone: MatchZone): number {
  return MS.formationSupport[role]?.[zone] ?? 0;
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
  // Club.tactics.pressing is a 0-2 scale (Light/Heavy/Very Heavy). Normalize to
  // [0,1] so press intensity is meaningful; `pressing.intensityDivisor` in
  // config targets a 0-100 scale that the club model does not use.
  return Math.max(0, Math.min(1, pressing / 2));
}

/** Tactical familiarity execution factor (§17). */
function execution(familiarity: number): number {
  return MS.tacticalFamiliarity.executionFloor + (MS.tacticalFamiliarity.executionCeiling - MS.tacticalFamiliarity.executionFloor) * (familiarity / 100);
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
  /** Bumped whenever `on` gains/loses a player or a player's tacPos changes
   *  (substitution, injury auto-sub); invalidates involvedCache below. */
  rosterVersion: number;
  /** Per-zone memo of involvedPlayers(side, zone): membership/weights depend
   *  only on tacPos + zone, not the per-step-changing readiness values on the
   *  same `ps` references, so it's safe to reuse until rosterVersion moves. */
  involvedCache: Partial<Record<MatchZone, { version: number; result: { ps: LivePlayerState; weight: number }[] }>>;
}

interface Engine {
  rng: RngState;
  st: LiveMatchState;
  home: Side;
  away: Side;
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
}

function sideOf(eng: Engine, side: 0 | 1): Side {
  return side === 0 ? eng.home : eng.away;
}
function opp(eng: Engine, side: 0 | 1): Side {
  return side === 0 ? eng.away : eng.home;
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

function buildPlayerState(p: Player, centers: AttributeCenters, energy = p.energy): LivePlayerState {
  const fit = positionFit(p.position, p.tacPos);
  const readiness = readinessFactor(energy);
  const z = (key: string, value: number) => robustZ(value, centers.median[key], centers.sigma[key]);
  return {
    id: p.id,
    skills: { ...p.skills },
    overall: p.overall,
    age: p.age,
    position: p.position,
    tacPos: p.tacPos,
    fit,
    energy,
    readiness,
    zTech: z("tec", p.skills.tec) * fit * readiness,
    zPace: z("vel", p.skills.vel) * fit * readiness,
    zPhysical: z("physical", physicalOf(p.skills)) * fit * readiness,
    zFinishing: z("fin", p.skills.fin) * fit * readiness,
    zGk: z("gol", p.skills.gol) * fit * readiness,
    zDiscipline: z("des", p.skills.des) * fit * readiness,
    onPitch: true,
  };
}

function refreshReadiness(ps: LivePlayerState, centers: AttributeCenters): void {
  const fit = positionFit(ps.position, ps.tacPos);
  ps.fit = fit;
  ps.readiness = readinessFactor(ps.energy);
  const z = (key: string, value: number) => robustZ(value, centers.median[key], centers.sigma[key]);
  ps.zTech = z("tec", ps.skills.tec) * fit * ps.readiness;
  ps.zPace = z("vel", ps.skills.vel) * fit * ps.readiness;
  ps.zPhysical = z("physical", physicalOf(ps.skills)) * fit * ps.readiness;
  ps.zFinishing = z("fin", ps.skills.fin) * fit * ps.readiness;
  ps.zGk = z("gol", ps.skills.gol) * fit * ps.readiness;
  ps.zDiscipline = z("des", ps.skills.des) * fit * ps.readiness;
}

function playerUsableZ(ps: LivePlayerState, key: "tech" | "pace" | "physical" | "finishing" | "gk" | "discipline"): number {
  switch (key) {
    case "tech": return ps.zTech;
    case "pace": return ps.zPace;
    case "physical": return ps.zPhysical;
    case "finishing": return ps.zFinishing;
    case "gk": return ps.zGk;
    case "discipline": return ps.zDiscipline;
  }
}

/** Local involved players in the current zone: those with support weight > 0. */
function involvedPlayers(side: Side, zone: MatchZone): { ps: LivePlayerState; weight: number }[] {
  const cached = side.involvedCache[zone];
  if (cached && cached.version === side.rosterVersion) return cached.result;
  const out: { ps: LivePlayerState; weight: number }[] = [];
  for (const ps of side.on) {
    const w = involvement(tacPosRole(ps.tacPos), zone);
    if (w > 0) out.push({ ps, weight: w });
  }
  side.involvedCache[zone] = { version: side.rosterVersion, result: out };
  return out;
}

/**
 * Selects a stable visual participant without touching the match RNG stream.
 * The simulator intentionally models possession at team/zone level; this
 * deterministic attribution gives the pitch a real jersey to animate while
 * keeping the simulation's probability model unchanged.
 */
function presentationPlayerId(side: Side, zone: MatchZone, excludeId: number | null = null, allowGoalkeeper = false): number | null {
  const local = involvedPlayers(side, zone)
    .filter(({ ps }) => allowGoalkeeper || ps.tacPos !== 1)
    .sort((a, b) => b.weight - a.weight || a.ps.tacPos - b.ps.tacPos || a.ps.id - b.ps.id);
  const pool = local.length > 0
    ? local
    : side.on
      .filter((ps) => allowGoalkeeper || ps.tacPos !== 1)
      .sort((a, b) => a.tacPos - b.tacPos || a.id - b.id)
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
function localQuality(side: Side, zone: MatchZone, key: "tech" | "pace" | "physical" | "finishing" | "gk" | "discipline"): number {
  const local = involvedPlayers(side, zone);
  if (local.length === 0) return 0;
  const values = local.map((l) => playerUsableZ(l.ps, key));
  const weights = local.map((l) => l.weight);
  return weightedMean(values, weights);
}

/** Team action quality (§11): weighted mean of usable attribute Z across local involvement. */
function actionQualityFor(side: Side, zone: MatchZone, action: string): number {
  const weights = MS.actionQuality.attributeWeights[action];
  if (!weights) return 0;
  let sum = 0;
  const local = involvedPlayers(side, zone);
  if (local.length === 0) return 0;
  for (const [attrKey, w] of Object.entries(weights)) {
    const canonical = SKILL_MAP[attrKey as keyof typeof SKILL_MAP];
    if (!canonical) continue;
    const values = local.map((l) => playerUsableZ(l.ps, canonical));
    const ws = local.map((l) => l.weight);
    sum += w * weightedMean(values, ws);
  }
  // A weighted mean alone hides a missing player when the remaining players
  // are near-average. Local density keeps the effect zone-specific: losing a
  // player reduces execution in the zones that player normally supports.
  return sum * localDensity(side, zone);
}

function defensiveResistanceFor(side: Side, zone: MatchZone, action: string): number {
  const weights = MS.actionQuality.defensiveResistanceWeights[action];
  if (!weights) return 0;
  let sum = 0;
  const local = involvedPlayers(side, zone);
  if (local.length === 0) return 0;
  for (const [attrKey, w] of Object.entries(weights)) {
    const canonical = SKILL_MAP[attrKey as keyof typeof SKILL_MAP];
    if (!canonical) continue;
    const values = local.map((l) => playerUsableZ(l.ps, canonical));
    const ws = local.map((l) => l.weight);
    sum += w * weightedMean(values, ws);
  }
  return sum * localDensity(side, zone);
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
    const role = tacPosRole(ps.tacPos);
    const kernel = MS.formationSupport[role] ?? {};
    for (const [zone, w] of Object.entries(kernel)) {
      const z = zone as MatchZone;
      side.support[z] += w;
      side.coverage[z] += w * (0.55 + 0.45 * ps.readiness);
    }
  }
  side.cachedBaselineOrganisation = baselineOrganisation(side);
}

function expectedSupport(formation: number): Record<MatchZone, number> {
  const out: Record<MatchZone, number> = { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 };
  const FORMATION_POSITIONS: number[][] = [
    [1, 20, 11, 13, 14, 16, 2, 9, 6, 4, 8],
    [1, 20, 11, 13, 14, 16, 2, 9, 6, 4, 8],
    [1, 22, 24, 12, 14, 16, 2, 9, 6, 4, 8],
    [1, 23, 11, 13, 15, 2, 9, 6, 8, 10, 17],
    [1, 22, 24, 11, 13, 14, 16, 2, 9, 3, 5],
    [1, 19, 21, 11, 12, 13, 15, 2, 9, 6, 8],
    [1, 22, 24, 12, 14, 15, 16, 2, 9, 6, 8],
    [1, 22, 23, 24, 12, 14, 16, 2, 9, 6, 8],
    [1, 19, 20, 21, 11, 13, 15, 2, 9, 6, 8],
    [1, 22, 24, 11, 13, 15, 4, 6, 8, 10, 17],
    [1, 18, 25, 23, 11, 13, 4, 6, 8, 10, 17],
    [1, 23, 14, 16, 15, 13, 11, 2, 9, 6, 8],
    [1, 20, 10, 17, 15, 13, 11, 2, 9, 6, 8],
  ];
  const roles = (FORMATION_POSITIONS[formation] ?? FORMATION_POSITIONS[4]).map(tacPosRole);
  for (const role of roles) {
    const kernel = MS.formationSupport[role] ?? {};
    for (const [zone, w] of Object.entries(kernel)) {
      out[zone as MatchZone] += w;
    }
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

function pressSignal(eng: Engine, side: Side, zone: MatchZone): number {
  const intensity = side.tactics.pressing;
  if (intensity <= 0) return 0;
  const localSupport = (side.support[zone] ?? 0) / Math.max(1e-6, side.expectedSupport[zone] ?? 1);
  const local = involvedPlayers(side, zone);
  const readinessMean = local.length > 0 ? weightedMean(local.map((l) => l.ps.readiness), local.map((l) => l.weight)) : 1;
  const raw = intensity * localSupport * execution(side.tactics.familiarity) * readinessMean;
  // Standardize against the neutral reference (raw ≈ 1 at moderate press).
  const z = (raw - 0.6) / 0.5;
  return clamp(z, -MS.normalization.contestZClamp, MS.normalization.contestZClamp);
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

/** Destination lane preference (used for next-zone lane selection). */
function directionSignal(eng: Engine, candidateLane: Lane): number {
  const side = sideOf(eng, eng.possessionSide);
  const vals = LANES.map((l) => laneScore(side.tactics, l));
  const standardized = robustStandardize(vals);
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
  // Compute a representative sigma by evaluating the tactical component spread
  // across all zones with the current sides' tactics (plan §19).
  const samples: number[] = [];
  for (const zone of ZONES) {
    samples.push(shapeSignal(eng, zone));
    samples.push(pressSignal(eng, sideOf(eng, eng.possessionSide), zone));
    samples.push(pressSignal(eng, opp(eng, eng.possessionSide), zone));
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

function controlledDuration(rng: RngState, action: string, phase: MatchPhase, zone: MatchZone): number {
  const params = gammaParams(action, phase, zone);
  if (params) {
    const sample = gamma(rng, params.shape) * params.scale;
    return sample / MS.timing.tempoScale;
  }
  return MS.timing.instantActionSeconds / MS.timing.tempoScale;
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
  return row.intentProbabilities;
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

function nextZoneBaseline(eng: Engine, action: string): Record<string, number> {
  const row = MS.probabilityModel.nextZoneByStateAction[`${stateKey(eng.phase, eng.zone)}.${action}`];
  return row ? { ...row } : {};
}

// ---------------------------------------------------------------------------
// Control failure (§9)
// ---------------------------------------------------------------------------

function controlFailureStep(eng: Engine): FailureAction | null {
  const att = eng.possessionSide;
  const def = opp(eng, att);
  const { controlFailureProbability, miscontrol, dispossessed } = failureBaseline(eng);
  const zBallSecurity = localQuality(sideOf(eng, att), eng.zone, "tech");
  const zOppPress = pressSignal(eng, def, eng.zone);
  const logitP = logit(controlFailureProbability) - INFLUENCE_SCALES.teamScale * zBallSecurity + INFLUENCE_SCALES.tacticsScale * zOppPress;
  const pFail = logistic(logitP);
  if (nextDouble(eng.rng) < pFail) {
    const misU = Math.log(miscontrol);
    const dispU = Math.log(dispossessed);
    return choice(eng.rng, ["MISCONTROL", "DISPOSSESSED"], [misU, dispU]) as FailureAction;
  }
  return null;
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
  return choice(eng.rng, labels, utilities);
}

/** Centered action-mix correction outside the neutral CONTROL/CONTROL matchup. */
function asymmetricActionUtility(eng: Engine, action: string): number {
  const side = sideOf(eng, eng.possessionSide);
  const opposingStyle = opp(eng, eng.possessionSide).tactics.style;
  if (side.tactics.style === "CONTROL" && opposingStyle === "CONTROL") return 0;
  const scale = MS.tacticalActionMix.nonNeutralCorrectionScale;
  return scale * (MS.tacticalActionMix.asymmetricActionUtility[action] ?? 0);
}

/** Style/direction/familiarity tactical signal for an action intent (§14/§19). */
function tacticalSignalForAction(eng: Engine, action: string): number {
  const side = sideOf(eng, eng.possessionSide);
  const style = side.tactics.style;
  const components: number[] = [];
  // Shape
  components.push(shapeSignal(eng, eng.zone));
  // Familiarity
  components.push((side.tactics.familiarity - 50) / 50);
  if (style === "CONTROL") {
    // riskScore(action) = robust standardized logit(TURNOVER | state, action)
    const legal = Object.keys(intentBaseline(eng)).filter((a) => a !== "SHOT");
    const logits = legal.map((a) => logit(outcomeBaseline(eng, a).turnover + 1e-9));
    const standardized = robustStandardize(logits);
    const idx = legal.indexOf(action);
    if (idx >= 0) {
      const styleSignal = -standardized[idx];
      components.push(styleSignal);
    }
  } else if (style === "COUNTER") {
    if (eng.phase === "TRANSITION") {
      const expected = Math.max(expectedActionSeconds(action), MS.timing.instantActionSeconds);
      const speed = Math.max(LONG_RANK[eng.zone] / 3, 0) / expected;
      components.push(speed);
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

function foulContextShift(eng: Engine, defSide: Side): number {
  const local = involvedPlayers(defSide, eng.zone);
  const localReadiness = local.length > 0
    ? weightedMean(local.map((l) => l.ps.readiness), local.map((l) => l.weight))
    : 1;
  // Discipline risk: 1 - meanDiscipline. localQuality is a Z in [-3,3]; map it
  // to a 0..1 discipline score around 0.5.
  const disciplineZ = localQuality(defSide, eng.zone, "discipline");
  const discipline = clamp(0.5 - disciplineZ * 0.08, 0, 1);
  const disciplineRisk = 1 - discipline;
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
  const zExec = clamp(
    (actionQualityFor(sideOf(eng, att), eng.zone, action) - defensiveResistanceFor(def, eng.zone, action)) / Math.SQRT2 +
      MS.actionQuality.localDensityCoefficient * (localDensity(sideOf(eng, att), eng.zone) - localDensity(def, eng.zone)),
    -MS.normalization.contestZClamp,
    MS.normalization.contestZClamp
  );
  const zPress = pressSignal(eng, def, eng.zone);
  const continueU = utility(eng, Math.log(base.continue), zExec, -INFLUENCE_SCALES.tacticsScale * zPress, 0);
  const turnoverU = utility(eng, Math.log(base.turnover), -zExec, INFLUENCE_SCALES.tacticsScale * zPress, 0);
  const foulShift = foulContextShift(eng, def);
  const foulU = utility(eng, Math.log(base.foul), 0, 0, foulShift);
  const retainedU = utility(eng, Math.log(base.retainedRestart), 0, 0, 0);
  return choice(eng.rng, ["CONTINUE", "TURNOVER", "FOUL", "RETAINED_RESTART"], [continueU, turnoverU, foulU, retainedU]) as Outcome;
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

  const components: number[] = [];
  components.push(shapeSignal(eng, next));
  components.push((side.tactics.familiarity - 50) / 50);
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
  components.push(styleRaw);
  // Direction preference (lane handled separately, but include for wide/centre routing).
  const dir = directionSignal(eng, destinationLaneFor(eng, next));
  const zTacticsTotal = combineTactics(eng, [...components, dir]);
  // Home advantage creation: apply to attacking PROGRESSION utility (§29) so
  // the home team reaches advanced/box zones slightly more often.
  let cu = 0;
  if (eng.possessionSide === 0 && !eng.st.homeNeutral) {
    const nextRank = LONG_RANK[next];
    if (nextRank > currentRank && nextRank >= 2) {
      cu = Math.log(creationMultiplier(eng));
    }
  }
  return utility(eng, baseLogP, 0, zTacticsTotal, cu);
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
  return choice(eng.rng, candidates, utilities) as MatchZone;
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
  const candidates = involvedPlayers(side, zone).filter((l) => l.ps.tacPos !== 1);
  if (candidates.length === 0) return side.on.find((ps) => ps.tacPos !== 1) ?? side.on[0];
  const weights = candidates.map((l) => {
    const role = tacPosRole(l.ps.tacPos);
    const roleWeight = MS.shotModel.shooterRoleWeights[role] ?? 0.2;
    const finishingZ = l.ps.zFinishing;
    const finishingFactor = Math.max(MS.shotModel.shooterFinishingFloor, finishingZ + MS.shotModel.shooterFinishingOffset);
    return Math.max(MS.shotModel.shooterMinimumWeight, l.weight * finishingFactor * roleWeight);
  });
  const labels = candidates.map((l) => String(l.ps.id));
  const chosen = weightedPick(eng.rng, labels, weights);
  return candidates.find((l) => String(l.ps.id) === chosen)?.ps ?? candidates[0].ps;
}

function shotLocationForZone(eng: Engine, zone: MatchZone): { x: number; y: number } {
  // Virtual pitch coordinates in 0-120 (x) by 0-80 (y) units; the goal is at
  // x=120, y=40. Seeded jitter spreads shots across the empirical distance and
  // angle bins rather than clustering at each zone's centre.
  const base: Record<MatchZone, { x: number; y: number }> = {
    DEF_WIDE: { x: 12, y: 66 },
    DEF_CENTRAL: { x: 14, y: 40 },
    MID_WIDE: { x: 45, y: 66 },
    MID_CENTRAL: { x: 50, y: 40 },
    ATT_WIDE: { x: 88, y: 66 },
    ATT_CENTRAL: { x: 95, y: 40 },
    BOX: { x: 111, y: 40 },
  };
  const c = base[zone] ?? { x: 95, y: 40 };
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
  situation: string;
  pressured: boolean;
  distance: number;
}

function resolveShot(eng: Engine, side: Side, def: Side): ShotResult {
  const shooter = shooterSelection(eng, side);
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
  }

  const zFinish = shooter.zFinishing;
  // The goalkeeper defends the conversion draw directly (plan §28): find the
  // GK on the pitch, not a zone-local quality (the GK's zone involvement is
  // only DEF_CENTRAL and shots occur in ATT/BOX zones).
  const gk = def.on.find((ps) => ps.tacPos === 1);
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
  }

  return { goal, onTarget, blocked, saved, woodwork, rebound, finalXg: finalXgC, shooter, situation, pressured, distance };
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
  const disciplineRisk = 1 - Math.max(0, Math.min(1, fouler.zDiscipline * 0.08 + 0.5));
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

const epvTable: Record<string, number> & { __computed?: boolean } = {};

function selectFouler(eng: Engine, def: Side): LivePlayerState {
  const local = involvedPlayers(def, eng.zone);
  const pool = local.length > 0 ? local : def.on.map((ps) => ({ ps, weight: 1 }));
  const weights = pool.map((l) => {
    const press = l.ps.tacPos !== 1 ? l.weight * (0.4 + 0.6 * (1 - l.ps.readiness)) : 0;
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
  side.rosterVersion++;
  computeSupport(side);
}

/**
 * Bench player who replaces a player removed by a match injury. Goalkeepers can
 * only be replaced by goalkeepers; an outfield player prefers the same natural
 * position and otherwise falls back to the best remaining outfielder.
 * Deterministic (overall desc, then lower id): no RNG draw, so instant and
 * streamed runs — and restarts — always agree. Exported for tests.
 */
export function pickInjuryReplacement(bench: Player[], outPosition: number): Player | null {
  const eligible = bench.filter((p) => p.injuryDays === 0 && p.suspendedGames === 0);
  const rank = (a: Player, b: Player) => b.overall - a.overall || a.id - b.id;
  if (outPosition === 0) return eligible.filter((p) => p.position === 0).sort(rank)[0] ?? null;
  const samePosition = eligible.filter((p) => p.position === outPosition).sort(rank)[0];
  if (samePosition) return samePosition;
  return eligible.filter((p) => p.position !== 0).sort(rank)[0] ?? null;
}

/**
 * Automatic substitution for a player just removed by a match injury
 * (`gameConfig.injuries.autoSubstitute`). Consumes one of the side's shared
 * substitution slots; without slots or an eligible candidate the team simply
 * continues one player short (red-card semantics, plan 9 §17).
 *
 * Mirrors `performLiveSub` bookkeeping inside the engine so the change is
 * picked up immediately and survives persistence: pitch/bench lists, slot
 * counter, SUB event + substitution record, and the energy/load/minutes maps
 * the full-time commit reads. Idempotent across chunks: the next engine build
 * starts from persisted state where the injured player is already off the
 * pitch, so this fires exactly once per injury.
 */
function applyInjuryAutoSub(eng: Engine, side: Side, outPs: LivePlayerState, minute: number): void {
  if (!gameConfig.injuries.autoSubstitute) return;
  if ((eng.st.usedSubs[side.idx] ?? 0) >= MP_CONFIG.maxSubsPerSide) return;
  const incoming = pickInjuryReplacement(side.bench, outPs.position);
  if (!incoming) return;
  // The replacement occupies the injured player's tactical slot.
  incoming.tacPos = outPs.tacPos;
  const ps = buildPlayerState(incoming, eng.centers, eng.st.playerEnergy[incoming.id] ?? incoming.energy);
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

/** Injury hazard check for the acting side (plan §37). Normalized so neutral
 *  simulations average `injuries.targetPerMatch`. A single RNG draw per action
 *  keeps the stream chunk-independent (determinism between instant and
 *  streamed simulation). */
function resolveInjuryHazard(eng: Engine, action: string, minute: number, addedTime?: number): void {
  const expectedActionsPerMatch = 2 * (MS.validation.reference["TEAM_MATCH.modeledActions"]?.mean ?? 956);
  const rawActions = ENERGY_INJURY_MODEL.injuryRisk.actionRiskRaw;
  const rawAction = rawActions[action] ?? rawActions.PASS;
  // Spec §13.5 normalizes with the neutral empirical action distribution from
  // football-baseline.json; that artifact is not in the repository yet, so the
  // unweighted mean over the versioned table stands in until it lands.
  const meanRawActionRisk = Object.values(rawActions).reduce((sum, value) => sum + value, 0) / Object.values(rawActions).length;
  const referenceRisk = injuryRiskMultiplier(ENERGY_INJURY_MODEL.injuryRisk.referenceEnergy, ENERGY_INJURY_MODEL.injuryRisk.referenceRecentLoad, ENERGY_INJURY_MODEL.injuryRisk.ageReference);
  const baseHazardPerAction = gameConfig.injuries.matchTargetPerMatch / Math.max(1, expectedActionsPerMatch * referenceRisk);
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
  for (const ps of side.on) {
    const involvementWeight = involvement(tacPosRole(ps.tacPos), eng.zone);
    const press = side.tactics.pressing * 100;
    ps.energy = Math.max(0, ps.energy - energyLoss({ energy: ps.energy, age: ps.age, physicalSkill: physicalSkill({ skills: ps.skills }), position: ps.position, pressing: press, involvement: involvementWeight, minutes }));
    eng.playerMatchLoad[ps.id] = (eng.playerMatchLoad[ps.id] ?? 0) + loadIncrement({ position: ps.position, pressing: press, involvement: involvementWeight, minutes });
    refreshReadiness(ps, eng.centers);
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
  return side.on.filter((ps) => ps.tacPos >= 18).length;
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
  const counterExecution = execution(sideOf(eng, att).tactics.familiarity);
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
  const dt = controlledDuration(eng.rng, action, actionPhase, eng.zone);
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
    const shotGk = def.on.find((ps) => ps.tacPos === 1) ?? null;
    ballAction.fromPlayerId = result.shooter?.id ?? ballAction.fromPlayerId;
    ballAction.targetPlayerId = result.saved ? shotGk?.id ?? null : null;
    stats.shots++;
    stats.xG += result.finalXg;
    if (result.onTarget) stats.shotsOnTarget++;
    if (result.goal) {
      finishBallAction(ballAction, { outcome: "GOAL", toZone: null, targetPlayerId: null });
      const club = sideOf(eng, attSide).club;
      eng.scores[attSide]++;
      eng.events.push({
        minute: displayMinute, half: eventHalf, type: EVENT_CODES.GOAL, subtype: GOAL_SUBTYPES.NORMAL,
        clubId: club.id, playerId: result.shooter?.id ?? null, player2Id: null, goalType: GOAL_SUBTYPES.NORMAL,
        ...(displayAddedTime !== undefined ? { addedTime: displayAddedTime } : {}),
      });
      if (result.shooter) {
        const p = eng.onPitchBySide[attSide].find((p) => p.id === result.shooter?.id);
        if (p) {
          p.seasonGoals++;
          p.careerGoals++;
        }
      }
      eng.commentary.push(`${result.shooter ? sideOf(eng, attSide).club.name : ""} score`);
      // KICK_OFF for opponent
      eng.possessionSide = attSide === 0 ? 1 : 0;
      beginPossession(eng, "KICK_OFF");
      return;
    }
    // Curated timeline events for notable non-goal shots: goalkeeper saves and
    // woodwork hits. Blocked/off-target misses stay unrecorded to keep feeds
    // readable. A save credits the defending goalkeeper with the shooter as
    // the secondary player ("GK saved shot by shooter" in the feed); WOODWORK
    // stays attributed to the shooter who hit it. The WOODWORK subtype marks
    // an on-target hit so goals + saves + on-target woodwork reconciles
    // exactly with shotsOnTarget (saves counted for the defending side).
    if (result.saved || result.woodwork) {
      const shotClubId = sideOf(eng, attSide).club.id;
      const gk = shotGk;
      eng.events.push({
        minute: displayMinute, half: eventHalf,
        type: result.saved ? EVENT_CODES.SAVE : EVENT_CODES.WOODWORK,
        subtype: !result.saved && result.onTarget ? 1 : 0,
        clubId: result.saved ? def.club.id : shotClubId,
        playerId: result.saved ? (gk?.id ?? null) : (result.shooter?.id ?? null),
        player2Id: result.saved ? (result.shooter?.id ?? null) : null,
        goalType: 0,
        ...(displayAddedTime !== undefined ? { addedTime: displayAddedTime } : {}),
      });
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
    finishBallAction(ballAction, { toZone: eng.zone, targetPlayerId: eng.ballCarrierId });
    return;
  }

  // RETAINED_RESTART
  if (outcome === "RETAINED_RESTART") {
    const zone = eng.zone;
    const restartRow = MS.probabilityModel.restartTypeByZone[zone];
    const labels = Object.keys(restartRow);
    const weights = labels.map((l) => restartRow[l]);
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
  const outfield = sideOf(eng, attSide).on.filter((ps) => ps.tacPos !== 1);
  if (outfield.length === 0) return null;
  const preferred = outfield.filter((ps) => ["LW", "RW", "LM", "RM", "ST"].includes(tacPosRole(ps.tacPos)));
  const pool = preferred.length > 0 ? preferred : outfield;
  return pool[(cornerOrdinal - 1) % pool.length].id;
}

function runMatch(eng: Engine, targetClockSeconds?: number, opts?: { pauseAtHalftime?: boolean }): void {
  // console.log(`[runMatch start] clock ${eng.clockSeconds} target ${targetClockSeconds} firstAdded ${eng.st.firstHalfAddedMinutes} secondAdded ${eng.st.secondHalfAddedMinutes} period ${eng.period} pause ${opts?.pauseAtHalftime}`);
  let guard = 0;
  while (!eng.ended && guard++ < 500000) {
    // Freeze stoppage as soon as we reach the raw boundary so the added window is known before stepping into it.
    ensureStoppageComputed(eng);
    const boundary = periodEndSeconds(eng);
    // Respect explicit target (live tick) — stop when we have reached it.
    if (targetClockSeconds !== undefined && eng.clockSeconds >= targetClockSeconds) break;
    if (eng.clockSeconds >= boundary) {
      if (eng.period === 1) {
        pushHalfTimeWhistle(eng);
        if (opts?.pauseAtHalftime) {
          // Pause at halftime (first half + its added time) — do not flip period yet.
          // console.log(`[runMatch pause] clock ${eng.clockSeconds} boundary ${boundary}`);
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
      if (eng.st.decider && eng.st.scores[0] === eng.st.scores[1] && !eng.extraTimePlayed) {
        eng.extraTimePlayed = true;
        pushShootoutAnnouncement(eng);
        doShootout(eng);
      }
      pushFullTimeWhistle(eng);
      eng.ended = true;
      break;
    }
    // If we have an explicit target and the next step would overshoot it, let stepPossession
    // handle the clock increment and then the next loop will break on the target check above.
    if (targetClockSeconds !== undefined && eng.clockSeconds >= targetClockSeconds) break;
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

function doShootout(eng: Engine): void {
  const takers: LivePlayerState[][] = [eng.home.on.filter((ps) => ps.tacPos !== 1), eng.away.on.filter((ps) => ps.tacPos !== 1)];
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
  centers: AttributeCenters
): Engine {
  // The engine's authoritative RNG stream is the persisted state stream, so a
  // live match resumes deterministically after a reload; `rng` is only the
  // fallback for states created before the stream field existed.
  const engineRng = st.rngState ?? { seed: rng.seed, state: rng.state };
  const playersById = new Map(players.map((p) => [p.id, p]));
  const resolve = (ids: number[]) => ids.map((id) => playersById.get(id)).filter((p): p is Player => !!p);
  st.playerEnergy ??= {};
  const homeXI = resolve(st.homeOn);
  const awayXI = resolve(st.awayOn);

  const homeSide: Side = {
    idx: 0,
    club: home,
    on: homeXI.map((p) => buildPlayerState(p, centers, st.playerEnergy[p.id] ?? p.energy)),
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
  };
  const awaySide: Side = {
    idx: 1,
    club: away,
    on: awayXI.map((p) => buildPlayerState(p, centers, st.playerEnergy[p.id] ?? p.energy)),
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
    isCounter: false,
    lastAction: st.lastAction ?? null,
    prevZone: st.prevZone ?? null,
    ballCarrierId: st.ballCarrierId != null && (st.withBall === 0 ? homeXI : awayXI).some((p) => p.id === st.ballCarrierId)
      ? st.ballCarrierId
      : null,
    ballActionSequence: st.ballActionSequence ?? 0,
    lastBallAction: st.lastBallAction ? { ...st.lastBallAction } : null,
    possessionHighRecovery: false,
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
  diagnosticsOut?: MatchSimulationDiagnostics
): void {
  const eng = buildEngine(rng, home, away, players, st, centers);
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
  opts?: { pauseAtHalftime?: boolean }
): void {
  const eng = buildEngine(rng, home, away, players, st, centers);
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
  st.lastAction = eng.lastAction;
  st.prevZone = eng.prevZone;
  st.ballCarrierId = eng.ballCarrierId;
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

export function centersForWorld(world: World): AttributeCenters {
  // Skills and squad membership change during a season, so a seed-only cache
  // would silently normalize new ratings against stale player distributions.
  return computeAttributeCenters(world.players);
}
