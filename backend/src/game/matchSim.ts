import type { Club, LiveCardState, LiveInjuryState, LiveMatchState, LiveSubstitutionState, LiveTactics, MatchEvent, Player, RngState, TeamMatchStats, World } from "./types";
import { MATCH_SIMULATOR_CONFIG as MS, INFLUENCE_SCALES } from "../matchSimulatorConfig";
import { nextDouble, gamma } from "./rng";
import { EVENT_CODES, GOAL_SUBTYPES } from "./constants";
import { injuryDays as injuryDaysDuration } from "./player";

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
  const { fullEnergyThreshold, maxPenalty, curveExponent } = MS.readiness;
  if (energy >= fullEnergyThreshold) return 1;
  const p = (fullEnergyThreshold - energy) / fullEnergyThreshold;
  return 1 - maxPenalty * Math.pow(p, curveExponent);
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
  possessionHighRecovery: boolean;
  opponentControlSeconds: [number, number];
  pressureAdvancedStates: [number, number];
  pressureWindowStart: [number, number];
  onPitchBySide: [Player[], Player[]];
  centers: AttributeCenters;
  homeOn: Player[];
  awayOn: Player[];
  playerMinutes: Record<number, number>;
  commentary: string[];
  ended: boolean;
  extraTimePlayed: boolean;
  shootout: { scores: [number, number]; winner: number } | null;
  playerYellows: Record<number, number>;
  scores: [number, number];
  deadBallSeconds: number;
  controlledOnlySeconds: number;
  actions: number;
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
  const out: { ps: LivePlayerState; weight: number }[] = [];
  for (const ps of side.on) {
    const w = involvement(tacPosRole(ps.tacPos), zone);
    if (w > 0) out.push({ ps, weight: w });
  }
  return out;
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
  return sum;
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
  return sum;
}

// ---------------------------------------------------------------------------
// Formation support / coverage (§15)
// ---------------------------------------------------------------------------

function computeSupport(side: Side): void {
  const support: Record<MatchZone, number> = { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 };
  const coverage: Record<MatchZone, number> = { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 };
  for (const ps of side.on) {
    const role = tacPosRole(ps.tacPos);
    const kernel = MS.formationSupport[role] ?? {};
    for (const [zone, w] of Object.entries(kernel)) {
      const z = zone as MatchZone;
      support[z] += w;
      coverage[z] += w * (0.55 + 0.45 * ps.readiness);
    }
  }
  side.support = support;
  side.coverage = coverage;
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
  // Home advantage creation multiplier (§29): only attacking progression /
  // chance-intent utility when home and in an advanced zone.
  const att = eng.possessionSide;
  const homeNeutral = eng.st.homeNeutral;
  if (att === 0 && !homeNeutral) {
    const rank = LONG_RANK[eng.zone];
    if (rank >= 1 && (action === "PASS" || action === "CARRY" || action === "CROSS" || action === "DRIBBLE")) {
      cu += Math.log(creationMultiplier(eng));
    }
  }
  // Pressing CONTINUE penalty / TURNOVER bonus applied in outcome step instead.
  return cu;
}

let _creationMultiplier: number | null = null;
function creationMultiplier(eng: Engine): number {
  if (_creationMultiplier !== null) return _creationMultiplier;
  const baseTeamXg = MS.validation.reference["TEAM_MATCH.xG"]?.mean ?? 1.28;
  const m = 1 + MS.homeAdvantage.creationShare * (MS.homeAdvantage.targetXg / baseTeamXg);
  _creationMultiplier = m;
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
    const cu = contextUtility(eng, action);
    return utility(eng, baseLogP, zTeam, zTactics, cu);
  });
  return choice(eng.rng, labels, utilities);
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
    if (idx >= 0) components.push(-standardized[idx]);
  } else if (style === "COUNTER") {
    if (eng.phase === "TRANSITION") {
      const expected = Math.max(expectedActionSeconds(action), MS.timing.instantActionSeconds);
      const speed = Math.max(LONG_RANK[eng.zone] / 3, 0) / expected;
      components.push(speed);
    }
    // else styleRaw = 0
  }
  return combineTactics(eng, components);
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
    (actionQualityFor(sideOf(eng, att), eng.zone, action) - defensiveResistanceFor(def, eng.zone, action)) / Math.SQRT2,
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

function beginPossession(eng: Engine, restart: string | null, keepLane = false): void {
  eng.possessionAgeSeconds = 0;
  eng.isCounter = false;
  eng.possessionHighRecovery = false;
  // Count each possession for both teams (the possession side was set before
  // calling beginPossession).
  const ownerStats = eng.stats[eng.possessionSide === 0 ? "home" : "away"];
  ownerStats.possessions++;
  const start = samplePossessionStart(eng, restart);
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
  if (eng.possessionSide === 0 && !eng.st.homeNeutral) {
    return homeShotQualityLogitShift(eng);
  }
  return 0;
}

let _homeShift: number | null = null;
function homeShotQualityLogitShift(eng: Engine): number {
  if (_homeShift !== null) return _homeShift;
  const baseTeamXg = MS.validation.reference["TEAM_MATCH.xG"]?.mean ?? 1.28;
  const baseTeamShots = MS.validation.reference["TEAM_MATCH.shots"]?.mean ?? 12.5;
  const p0 = baseTeamXg / baseTeamShots;
  const p1 = p0 + (MS.homeAdvantage.shotQualityShare * MS.homeAdvantage.targetXg) / baseTeamShots;
  _homeShift = logit(p1) - logit(p0);
  return _homeShift;
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
  const finalXg = logistic(logit(baselineXg) + MS.shotModel.finisherVsGoalkeeperLogitCoefficient * shotSkillSignal + shotQualityLogitShift(eng));
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

function resolveCards(eng: Engine, fouler: LivePlayerState, def: Side, minute: number): void {
  const { pYellow, pRed } = cardRates();
  const shift = cardLogitShift(eng, fouler, def);
  const redU = logit(pRed) + shift;
  const redP = logistic(redU);
  const yellowU = logit(pYellow) + shift;
  const yellowP = logistic(yellowU);

  const isRed = nextDouble(eng.rng) < redP;
  const isYellow = !isRed && nextDouble(eng.rng) < yellowP;

  const club = def.club;
  if (isRed) {
    eng.cards.push({ playerId: fouler.id, kind: "RED", minute });
    eng.stats[def.idx === 0 ? "home" : "away"].reds++;
    eng.events.push({
      minute, half: eng.period, type: EVENT_CODES.RED, subtype: 0, clubId: club.id, playerId: fouler.id, player2Id: null, goalType: 0,
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
      });
      removeFromPitch(eng, def, fouler.id);
    } else {
      eng.cards.push({ playerId: fouler.id, kind: "YELLOW", minute });
      eng.stats[def.idx === 0 ? "home" : "away"].yellows++;
      eng.events.push({
        minute, half: eng.period, type: EVENT_CODES.YELLOW, subtype: 0, clubId: club.id, playerId: fouler.id, player2Id: null, goalType: 0,
      });
    }
  }
}

function removeFromPitch(eng: Engine, side: Side, playerId: number): void {
  side.on = side.on.filter((ps) => ps.id !== playerId);
  eng.onPitchBySide[side.idx] = eng.onPitchBySide[side.idx].filter((p) => p.id !== playerId);
  computeSupport(side);
}

/** Injury hazard check for the acting side (plan §37). Normalized so neutral
 *  simulations average `injuries.targetPerMatch`. A single RNG draw per action
 *  keeps the stream chunk-independent (determinism between instant and
 *  streamed simulation). */
function resolveInjuryHazard(eng: Engine, side: Side, minute: number): void {
  const expectedActionsPerMatch = 2 * (MS.validation.reference["TEAM_MATCH.modeledActions"]?.mean ?? 956);
  const baseHazardPerAction = MS.injuries.targetPerMatch / Math.max(1, expectedActionsPerMatch);
  const involved = involvedPlayers(side, eng.zone);
  if (involved.length === 0) return;
  // One aggregate hazard roll for the whole acting side; the victim is then
  // selected from the involved players so a red-card-like removal is rare but
  // deterministic.
  let riskSum = 0;
  const risks: { ps: LivePlayerState; player: Player }[] = [];
  for (const { ps } of involved) {
    const player = eng.onPitchBySide[side.idx].find((p) => p.id === ps.id);
    if (!player) continue;
    const workload = clamp((minutesPlayedLast72h(player) - 90) / 180, 0, 1);
    const fatigueRisk = 1 - ps.readiness;
    const ageYears = Math.max(0, ps.age - MS.injuries.ageRiskStartAge);
    const logRisk =
      MS.injuries.recentWorkloadLogRiskCoefficient * workload +
      MS.injuries.fatigueLogRiskCoefficient * fatigueRisk +
      MS.injuries.ageLogRiskPerYear * ageYears;
    const riskMultiplier = Math.exp(logRisk);
    const localActionInvolvement = ps.readiness;
    const pInjury = 1 - Math.exp(-baseHazardPerAction * riskMultiplier * localActionInvolvement);
    risks.push({ ps, player });
    riskSum += pInjury;
  }
  const pAny = 1 - Math.exp(-riskSum);
  if (nextDouble(eng.rng) >= pAny) return;
  // Select the victim proportional to its individual risk.
  let roll = nextDouble(eng.rng) * riskSum;
  for (const { ps, player } of risks) {
    const workload = clamp((minutesPlayedLast72h(player) - 90) / 180, 0, 1);
    const logRisk =
      MS.injuries.recentWorkloadLogRiskCoefficient * workload +
      MS.injuries.fatigueLogRiskCoefficient * (1 - ps.readiness) +
      MS.injuries.ageLogRiskPerYear * Math.max(0, ps.age - MS.injuries.ageRiskStartAge);
    const w = 1 - Math.exp(-baseHazardPerAction * Math.exp(logRisk) * ps.readiness);
    roll -= w;
    if (roll <= 0) {
      const days = injuryDaysDuration(eng.rng, player);
      player.injuryDays = days;
      eng.st.playerEnergy ??= {};
      eng.st.playerEnergy[ps.id] = ps.energy;
      eng.injuries.push({ playerId: ps.id, days, minute });
      eng.stats[side.idx === 0 ? "home" : "away"].injuries++;
      eng.events.push({
        minute, half: eng.period, type: EVENT_CODES.INJURY, subtype: 0, clubId: side.club.id, playerId: ps.id, player2Id: null, goalType: days,
      });
      ps.onPitch = false;
      removeFromPitch(eng, side, ps.id);
      return;
    }
  }
}

function minutesPlayedLast72h(player: Player): number {
  const minutes = player.recentMinutes ?? [];
  let total = 0;
  for (const m of minutes.slice(0, 3)) total += m;
  return total;
}

// ---------------------------------------------------------------------------
// Fatigue (§35)
// ---------------------------------------------------------------------------

function fatigueEnergyLoss(eng: Engine, side: Side, dtSeconds: number): void {
  const minutes = dtSeconds / 60;
  for (const ps of side.on) {
    const roleGroup = ps.tacPos === 1 ? "GK" : ps.tacPos <= 9 ? "DEF" : ps.tacPos <= 17 ? "MID" : "ATT";
    const roleLoad = MS.fatigue.roleLoad[roleGroup] ?? 1;
    const pressLoad = 1 + MS.fatigue.pressLoadCoefficient * side.tactics.pressing;
    const ageLoad = 1 + MS.fatigue.ageLoadCoefficient * Math.max(0, ps.age - MS.fatigue.agePenaltyStartAge);
    const staminaCapacity = staminaCapacityFor(ps);
    const energyTerm = 1 + MS.fatigue.lowEnergyAcceleration * (1 - ps.energy / 100);
    const fatiguePerMinute = MS.fatigue.perMinuteBase * roleLoad * pressLoad * ageLoad * (100 / Math.max(1, staminaCapacity)) * energyTerm;
    const involvementWeight = involvedPlayers(side, eng.zone).some((l) => l.ps.id === ps.id)
      ? MS.fatigue.involvementBase + MS.fatigue.involvementRange * 1
      : MS.fatigue.involvementBase;
    const loss = MS.fatigue.fatigueScale * fatiguePerMinute * minutes * involvementWeight;
    ps.energy = Math.max(1, ps.energy - loss);
    refreshReadiness(ps, eng.centers);
  }
  // Formation support/coverage feeds tactical and organisation signals, so it
  // must follow the same readiness changes in instant and streamed runs.
  computeSupport(side);
}

function staminaCapacityFor(ps: LivePlayerState): number {
  const physicalSkill = (ps.skills.vel + physicalOf(ps.skills)) / 2;
  const agePenalty = MS.fatigue.agePenaltyPerYear * Math.max(0, ps.age - MS.fatigue.agePenaltyStartAge);
  const physicalBonus = MS.fatigue.physicalBonusCoefficient * (physicalSkill - MS.fatigue.physicalBonusCenter);
  return clamp(100 - agePenalty + physicalBonus, MS.fatigue.staminaCapacityMin, MS.fatigue.staminaCapacityMax);
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
  }  // Stats counting
  const attSide = eng.possessionSide;
  const stats = eng.stats[attSide === 0 ? "home" : "away"];
  if (action === "PASS") stats.passes++;
  else if (action === "CROSS") stats.crosses++;
  else if (action === "CARRY") stats.carries++;
  else if (action === "DRIBBLE") stats.dribbles++;

  const dt = controlledDuration(eng.rng, action, eng.phase, eng.zone);
  eng.clockSeconds += dt;
  eng.possessionAgeSeconds += dt;
  eng.controlledSeconds[attSide] += dt;
  eng.controlledOnlySeconds += dt;
  eng.actions++;
  if (LONG_RANK[eng.zone] >= 2) eng.attThirdSeconds[attSide] += dt;

  // Fatigue uses actual match-clock progress.
  fatigueEnergyLoss(eng, attSide === 0 ? eng.home : eng.away, dt);
  updateOrganisation(eng, dt);

  // Minutes bookkeeping (approx: match-clock seconds → display minutes).
  eng.playerMinutes = eng.playerMinutes || {};
  for (const ps of sideOf(eng, attSide).on) {
    eng.playerMinutes[ps.id] = (eng.playerMinutes[ps.id] ?? 0) + dt / 60;
  }

  const displayMinute = Math.floor(eng.clockSeconds / 60) + 1;
  resolveInjuryHazard(eng, attSide === 0 ? eng.home : eng.away, displayMinute);

  // SHOT resolution
  if (action === "SHOT") {
    const def = opp(eng, attSide);
    const result = resolveShot(eng, sideOf(eng, attSide), def);
    stats.shots++;
    stats.xG += result.finalXg;
    if (result.onTarget) stats.shotsOnTarget++;
    if (result.goal) {
      const club = sideOf(eng, attSide).club;
      eng.scores[attSide]++;
      eng.events.push({
        minute: displayMinute, half: eng.period, type: EVENT_CODES.GOAL, subtype: GOAL_SUBTYPES.NORMAL,
        clubId: club.id, playerId: result.shooter?.id ?? null, player2Id: null, goalType: GOAL_SUBTYPES.NORMAL,
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
    // Non-goal shot resolution
    if (result.saved) {
      // Goalkeeper begins possession.
      eng.possessionSide = attSide === 0 ? 1 : 0;
      beginPossession(eng, null);
      return;
    }
    if (result.blocked) {
      // Live second ball — new possession, possible corner.
      eng.possessionSide = attSide === 0 ? 1 : 0;
      beginPossession(eng, null);
      return;
    }
    if (result.rebound) {
      // Rebound returns to BOX/ATT_CENTRAL for the same team.
      eng.zone = "BOX";
      eng.lane = "CENTRE";
      eng.phase = "FINAL_THIRD";
      return;
    }
    if (result.woodwork) {
      // Play continues — reset to a defensive restart.
      eng.possessionSide = attSide === 0 ? 1 : 0;
      beginPossession(eng, null);
      return;
    }
    // On-target save (controlled) handled above; a miss with no on-target = GK restart.
    eng.possessionSide = attSide === 0 ? 1 : 0;
    beginPossession(eng, null);
    return;
  }

  // Non-shot: resolve outcome
  const outcome = resolveOutcome(eng, action);

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
    resolveCards(eng, fouler, def, displayMinute);
    // Same team keeps possession; restart.
    if (eng.zone === "BOX") {
      // Defending foul in BOX → penalty restart (penalty shot resolves via the
      // PENALTY possession start which pins SHOT as the first action).
      stats.penalties++;
      beginPossession(eng, "PENALTY");
      eng.clockSeconds += MS.timing.deadBallSecondsPerRestart;
      eng.deadBallSeconds += MS.timing.deadBallSecondsPerRestart;
    } else {
      beginPossession(eng, "FREE_KICK");
      eng.clockSeconds += MS.timing.deadBallSecondsPerRestart;
      eng.deadBallSeconds += MS.timing.deadBallSecondsPerRestart;
    }
    return;
  }

  // RETAINED_RESTART
  if (outcome === "RETAINED_RESTART") {
    const zone = eng.zone;
    const restartRow = MS.probabilityModel.restartTypeByZone[zone];
    const labels = Object.keys(restartRow);
    const weights = labels.map((l) => restartRow[l]);
    const restart = weightedPick(eng.rng, labels, weights) as RestartType;
    if (restart === "CORNER") {
      stats.corners++;
    }
    if (restart === "THROW_IN" || restart === "FREE_KICK" || restart === "GOAL_KICK" || restart === "CORNER") {
      eng.clockSeconds += MS.timing.deadBallSecondsPerRestart;
      eng.deadBallSeconds += MS.timing.deadBallSecondsPerRestart;
    }
    beginPossession(eng, restart);
    return;
  }
}

// ---------------------------------------------------------------------------
// Match run loop
// ---------------------------------------------------------------------------

function periodEndSeconds(eng: Engine): number {
  return eng.period === 1 ? MS.timing.firstHalfEndSeconds : MS.timing.regulationSeconds;
}

function runMatch(eng: Engine, targetClockSeconds?: number): void {
  const target = targetClockSeconds ?? MS.timing.regulationSeconds;
  let guard = 0;
  while (!eng.ended && eng.clockSeconds < target && guard++ < 500000) {
    const boundary = periodEndSeconds(eng);
    if (eng.clockSeconds >= boundary) {
      if (eng.period === 1) {
        eng.period = 2;
        continue;
      }
      if (eng.st.decider && eng.st.scores[0] === eng.st.scores[1] && !eng.extraTimePlayed) {
        eng.extraTimePlayed = true;
        doShootout(eng);
      }
      eng.ended = true;
      break;
    }
    stepPossession(eng);
  }
  if (eng.clockSeconds >= MS.timing.regulationSeconds && !eng.ended) {
    if (eng.st.decider && eng.scores[0] === eng.scores[1] && !eng.extraTimePlayed) {
      eng.extraTimePlayed = true;
      doShootout(eng);
    }
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
  const resolve = (ids: number[]) => ids.map((id) => players.find((p) => p.id === id)).filter((p): p is Player => !!p);
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
    expectedSupport: expectedSupport(home.tactics.formation),
    expectedSupportTotal: 0,
    organisation: 0,
    baselineOrganisation: 0,
    organisationDisruption: 0,
    organisationRecoveryTime: 1,
    cachedBaselineOrganisation: 0,
  };
  const awaySide: Side = {
    idx: 1,
    club: away,
    on: awayXI.map((p) => buildPlayerState(p, centers, st.playerEnergy[p.id] ?? p.energy)),
    bench: resolve(st.awaySubs),
    tactics: st.awayTactics,
    support: { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 },
    coverage: { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 0, MID_CENTRAL: 0, ATT_WIDE: 0, ATT_CENTRAL: 0, BOX: 0 },
    expectedSupport: expectedSupport(away.tactics.formation),
    expectedSupportTotal: 0,
    organisation: 0,
    baselineOrganisation: 0,
    organisationDisruption: 0,
    organisationRecoveryTime: 1,
    cachedBaselineOrganisation: 0,
  };
  for (const side of [homeSide, awaySide]) {
    side.expectedSupportTotal = ZONES.reduce((s, z) => s + (side.expectedSupport[z] ?? 0), 0) || 7;
    computeSupport(side);
  }
  const hasPersistedOrganisation = st.matchClockSeconds > 0 || st.events.length > 0;
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
    possessionHighRecovery: false,
    opponentControlSeconds: st.opponentControlSeconds ?? [0, 0],
    pressureAdvancedStates: st.pressureWindowAdvancedStates ?? [0, 0],
    pressureWindowStart: st.pressureWindowStartSeconds ?? [0, 0],
    onPitchBySide: [homeXI, awayXI],
    centers,
    homeOn: homeXI,
    awayOn: awayXI,
    playerMinutes: { ...(st.playerMinutes ?? {}) },
    commentary: [],
    ended: st.ended ?? false,
    extraTimePlayed: st.extraTimePlayed ?? false,
    shootout: st.shootout ?? null,
    playerYellows: { ...(st.playerYellows ?? {}) },
    scores: [...(st.scores ?? [0, 0])] as [number, number],
    deadBallSeconds: 0,
    controlledOnlySeconds: 0,
    actions: 0,
  };

  // Initial possession
  // Only a brand-new match starts a fresh possession; a resumed live state
  // continues from its persisted zone/phase/lane.
  if (eng.clockSeconds <= 0) {
    beginPossession(eng, "KICK_OFF");
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
  targetSeconds?: number
): void {
  const eng = buildEngine(rng, home, away, players, st, centers);
  runMatch(eng, targetSeconds);
  writeBack(eng, st);
}

/** Advance a live match by `matchMinutes` (converted to match-clock seconds). */
export function advancePossessionMatch(
  rng: RngState,
  home: Club,
  away: Club,
  players: Player[],
  st: LiveMatchState,
  matchMinutes: number,
  centers: AttributeCenters
): void {
  const eng = buildEngine(rng, home, away, players, st, centers);
  const startClock = eng.clockSeconds;
  const target = Math.min(MS.timing.regulationSeconds, startClock + matchMinutes * 60);
  runMatch(eng, target);
  writeBack(eng, st);
}

function writeBack(eng: Engine, st: LiveMatchState): void {
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
  st.opponentControlSeconds = eng.opponentControlSeconds;
  st.pressureWindowAdvancedStates = eng.pressureAdvancedStates;
  st.pressureWindowStartSeconds = eng.pressureWindowStart;
  st.rngState = { ...eng.rng };
  st.ended = eng.ended;
  st.extraTimePlayed = eng.extraTimePlayed;
  st.shootout = eng.shootout ?? st.shootout;
  st.playerYellows = eng.playerYellows;
  st.playerMinutes = eng.playerMinutes;
  st.playerEnergy ??= {};
  for (const side of [eng.home, eng.away]) {
    for (const ps of side.on) st.playerEnergy[ps.id] = ps.energy;
  }
  st.homeOn = eng.home.on.map((ps) => ps.id);
  st.awayOn = eng.away.on.map((ps) => ps.id);
  st.scores = eng.scores;
  st.withBall = eng.possessionSide;
  st.possessionFirstAction = eng.pendingFirstAction;
  // Display minute from match clock.
  const atHalfTime = !eng.ended && !eng.extraTimePlayed && eng.clockSeconds >= MS.timing.firstHalfEndSeconds && eng.period === 1;
  st.minute = atHalfTime ? 0 : Math.min(120, Math.floor(eng.clockSeconds / 60));
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
