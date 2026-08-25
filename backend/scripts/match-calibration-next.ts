import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySavedLineup } from "../src/game/club";
import { EVENT_CODES } from "../src/game/constants";
import { setupKey } from "../src/game/familiarity";
import { createLiveMatchState, performLiveSub, simulateMatch, tickLiveMatch } from "../src/game/match";
import { overallFromSkills } from "../src/game/rating";
import { createRng } from "../src/game/rng";
import type { Club, Match, MatchSimulationDiagnostics, Player, Position, Tactics } from "../src/game/types";
import { MATCH_SIMULATOR_CONFIG } from "../src/matchSimulatorConfig";

/**
 * Calibration instrumentation: MATCH_SIM_OVERRIDE = "a.b.c=value,d.e.f=value"
 * patches coefficients in memory so sweep points never edit production config.
 */
function applyOverrides(): void {
  const raw = process.env.MATCH_SIM_OVERRIDE;
  if (!raw) return;
  const config = MATCH_SIMULATOR_CONFIG as Record<string, unknown>;
  for (const part of raw.split(/[;,]/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const path = part.slice(0, eq).trim().split(".");
    const value = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(value)) throw new Error(`MATCH_SIM_OVERRIDE value is not numeric: ${part}`);
    let cursor = config;
    for (let i = 0; i < path.length - 1; i++) {
      const next = cursor[path[i]] as Record<string, unknown> | undefined;
      if (!next) throw new Error(`MATCH_SIM_OVERRIDE path missing: ${part}`);
      cursor = next;
    }
    const leaf = path[path.length - 1];
    if (!(leaf in cursor)) throw new Error(`MATCH_SIM_OVERRIDE path missing: ${part}`);
    cursor[leaf] = value;
  }
}

type CalibrationRun = {
  match: Match;
  homeMeanEnergy: number;
  awayMeanEnergy: number;
  homeMeanLoad: number;
  awayMeanLoad: number;
};

type Sample = {
  goals: number;
  shots: number;
  shotsOnTarget: number;
  xg: number;
  corners: number;
  fouls: number;
  yellows: number;
  reds: number;
  straightReds: number;
  secondYellowReds: number;
  passes: number;
  injuries: number;
  homePossession: number;
  homeGoals: number;
  awayGoals: number;
  homeXg: number;
  awayXg: number;
  homeShots: number;
  awayShots: number;
  homePasses: number;
  awayPasses: number;
  homeTurnovers: number;
  awayTurnovers: number;
  homeCorners: number;
  awayCorners: number;
  homeMeanEnergy: number;
  awayMeanEnergy: number;
  homeMeanLoad: number;
  awayMeanLoad: number;
  diagnostics?: MatchSimulationDiagnostics | null;
};

type Summary = {
  name: string;
  count: number;
  means: Record<string, number>;
  percentiles: Record<string, [number, number, number]>;
  result: { home: number; draw: number; away: number };
  goalHistogram: Record<number, number>;
};

const ROOT = dirname(fileURLToPath(import.meta.url));
const TARGET_PATH = join(ROOT, "..", "config", "match-calibration-targets.json");
const CANDIDATE_JSON = join(ROOT, "..", "..", "plans", "match-calibration-candidate.json");
const TARGETS = JSON.parse(readFileSync(TARGET_PATH, "utf8")) as Record<string, unknown>;
const SEED = 0x51a7c0de;
const POSITIONS: Position[] = [0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 2, 3, 1, 4];
const STYLES: Record<string, number> = { CONTROL: 0, PRESS: 1, COUNTER: 2 };
const FAMILIARITY_LEVELS = [25, 50, 75, 90, 100];
const LOSS_MINUTES = [15, 30, 45, 60, 75];

function club(id: number, selectedTactics: Tactics): Club {
  return {
    id,
    name: id === 1 ? "Calibration Home" : "Calibration Away",
    shortName: id === 1 ? "H" : "A",
    ownerUserId: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    highestDivision: 1,
    cash: 1e8,
    stadiumName: "Ground",
    stadiumCapacity: 40000,
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    tactics: selectedTactics,
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    savedLineup: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

function makePlayer(id: number, clubId: number, position: Position, strength: number, energy: number): Player {
  const base = Math.max(1, Math.min(99, strength + (position === 1 ? 1 : position === 4 ? 2 : 0)));
  const skills = {
    gol: Math.max(1, Math.min(99, base + (position === 0 ? 5 : -8))),
    vel: base,
    tec: base,
    pas: base + (position === 3 ? 2 : 0),
    des: base + (position <= 2 ? 3 : -2),
    arm: base + (position === 2 ? 3 : 0),
    fin: base + (position === 4 ? 5 : -3),
  };
  return {
    id,
    name: `P${id}`,
    country: "BRA",
    age: 25,
    position,
    side: 0,
    skills,
    overall: overallFromSkills(position, skills),
    energy,
    salary: 100000,
    payrollPaidThroughDay: 0,
    payrollPaidAmount: 0,
    payrollPeriodStartDay: 0,
    value: 1e6,
    releaseClause: 1e6,
    injuryDays: 0,
    contractDays: 1000,
    isYouth: false,
    starter: false,
    careerGrowthConsumed: 0,
    careerDeclineConsumed: 0,
    skillAcc: [0, 0, 0, 0, 0, 0, 0],
    careerGoals: 0,
    careerAssists: 0,
    seasonGoals: 0,
    seasonAssists: 0,
    yellows: 0,
    reds: 0,
    clubId,
    tacPos: -1,
    onSale: false,
    suspendedGames: 0,
    loanId: null,
    // Neutral career shape: match calibration never develops players, so only
    // the type contract matters here.
    careerProfile: { growthPotential: 0, growthSpeed: 0, peakAge: 27, declinePotential: 0, declineSpeed: 0 },
    recentMinutes: [],
  };
}

function squad(clubId: number, strength: number, energy: number, offset: number): Player[] {
  return POSITIONS.map((position, index) => makePlayer(offset + index + 1, clubId, position, strength, energy));
}

function tactics(style: number, pressing = 0): Tactics {
  return { formation: 4, style, pressing, direction: 0 };
}

function clone(players: Player[]): Player[] {
  return players.map((player) => ({
    ...player,
    skills: { ...player.skills },
    skillAcc: [...player.skillAcc],
    recentMinutes: [...player.recentMinutes],
    careerProfile: { ...player.careerProfile },
  }));
}

function seedFamiliarity(target: Club, value: number): void {
  target.tacticFamiliarity = {
    [setupKey(target.tactics)]: { familiarity: value, lastUsedAbsoluteGameDay: null },
  };
}

function pair(
  index: number,
  homeStrength: number,
  awayStrength: number,
  homeTactics = tactics(0),
  awayTactics = tactics(0),
  energy = 100,
  outOfPosition = false,
  homeFamiliarity = 50,
  awayFamiliarity = 50,
) {
  const home = club(1, homeTactics);
  const away = club(2, awayTactics);
  seedFamiliarity(home, homeFamiliarity);
  seedFamiliarity(away, awayFamiliarity);
  const homePlayers = squad(1, homeStrength, energy, 1000);
  const awayPlayers = squad(2, awayStrength, energy, 2000);
  if (outOfPosition) {
    const ids = homePlayers.slice(0, 11).map((player) => player.id);
    [ids[1], ids[2]] = [ids[2], ids[1]];
    [ids[3], ids[9]] = [ids[9], ids[3]];
    applySavedLineup(home, homePlayers, {
      formation: 4,
      starters: ids,
      subs: homePlayers.slice(11, 23).map((player) => player.id),
      penaltyTakerId: null,
      freeKickTakerId: null,
    });
  }
  return { home, away, players: [...homePlayers, ...awayPlayers], seed: SEED + index * 7919 };
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function completedRun(match: Match, players: Player[]): CalibrationRun {
  const participants = (clubId: number) => players.filter((player) => player.clubId === clubId && (match.minutes?.[player.id] ?? 0) > 0);
  const home = participants(match.homeClubId);
  const away = participants(match.awayClubId);
  return {
    match,
    homeMeanEnergy: mean(home.map((player) => player.energy)),
    awayMeanEnergy: mean(away.map((player) => player.energy)),
    homeMeanLoad: mean(home.map((player) => player.recentLoad ?? 0)),
    awayMeanLoad: mean(away.map((player) => player.recentLoad ?? 0)),
  };
}

function full(
  index: number,
  homeStrength: number,
  awayStrength: number,
  homeTactics = tactics(0),
  awayTactics = tactics(0),
  energy = 100,
  neutral = true,
  outOfPosition = false,
  homeFamiliarity = 50,
  awayFamiliarity = 50,
): CalibrationRun {
  const setup = pair(index, homeStrength, awayStrength, homeTactics, awayTactics, energy, outOfPosition, homeFamiliarity, awayFamiliarity);
  const players = clone(setup.players);
  const result = simulateMatch(createRng(setup.seed), setup.home, setup.away, players, {
    competitionId: 1,
    fixtureId: index,
    year: 1,
    homeNeutral: neutral,
    collectDiagnostics: true,
  });
  return completedRun(result.match, players);
}

function calibrationRole(tacPos: number): "GK" | "CB" | "WIDE" | "CM" | "ATT" {
  if (tacPos === 1) return "GK";
  if (tacPos === 2 || tacPos === 9 || tacPos === 10 || tacPos === 17 || tacPos === 19 || tacPos === 21) return "WIDE";
  if (tacPos === 18 || tacPos === 25) return "ATT";
  if ((tacPos >= 3 && tacPos <= 8) || tacPos === 23) return "CB";
  return "CM";
}

function selectedLossIds(
  index: number,
  homeOn: number[],
  players: Player[],
  count: number,
  requestedRole: "AVERAGE" | "CB" | "WIDE" | "CM" | "ATT",
): number[] {
  if (count === 0) return [];
  const byId = new Map(players.map((player) => [player.id, player]));
  const outfield = homeOn
    .map((id) => byId.get(id))
    .filter((player): player is Player => Boolean(player) && calibrationRole(player.tacPos) !== "GK")
    .sort((a, b) => a.tacPos - b.tacPos || a.id - b.id);
  const pool = requestedRole === "AVERAGE" ? outfield : outfield.filter((player) => calibrationRole(player.tacPos) === requestedRole);
  if (pool.length < count) throw new Error(`Cannot remove ${count} ${requestedRole} player(s); only ${pool.length} available`);
  const start = index % pool.length;
  return Array.from({ length: count }, (_, offset) => pool[(start + offset) % pool.length].id);
}

function segmentedAvailability(
  index: number,
  minute: number,
  lossCount: number,
  role: "AVERAGE" | "CB" | "WIDE" | "CM" | "ATT" = "AVERAGE",
  substitute = false,
): CalibrationRun {
  const setup = pair(index, 55, 55);
  const players = clone(setup.players);
  const rng = createRng(setup.seed);
  const state = createLiveMatchState(rng, setup.home, setup.away, players, {
    matchId: index,
    competitionId: 1,
    fixtureId: index,
    homeNeutral: true,
  });
  tickLiveMatch(rng, setup.home, setup.away, players, state, minute, { ignoreHalfTime: true });
  const losses = selectedLossIds(index, state.homeOn, players, substitute ? 1 : lossCount, role);
  if (substitute) {
    performLiveSub(rng, setup.home, setup.away, players, state, 0, losses[0], state.homeSubs[0]);
  } else if (losses.length > 0) {
    const removed = new Set(losses);
    state.homeOn = state.homeOn.filter((id) => !removed.has(id));
    state.homeXI = state.homeXI.filter((id) => !removed.has(id));
  }
  tickLiveMatch(rng, setup.home, setup.away, players, state, 90 - minute, { ignoreHalfTime: true });
  const match: Match = {
    id: index,
    fixtureId: index,
    competitionId: 1,
    homeClubId: 1,
    awayClubId: 2,
    homeScore: state.scores[0],
    awayScore: state.scores[1],
    penaltyWinnerId: null,
    events: state.events,
    stats: state.teamStats,
    minuteEvents: [],
    minutes: state.playerMinutes,
  };
  const energyFor = (ids: number[]) => mean(ids.map((id) => state.playerEnergy?.[id] ?? 100));
  const loadFor = (ids: number[]) => mean(ids.map((id) => state.playerMatchLoad?.[id] ?? 0));
  return {
    match,
    homeMeanEnergy: energyFor(state.homeOn),
    awayMeanEnergy: energyFor(state.awayOn),
    homeMeanLoad: loadFor(state.homeOn),
    awayMeanLoad: loadFor(state.awayOn),
  };
}

function sample(run: CalibrationRun): Sample {
  const match = run.match;
  const home = match.stats.home;
  const away = match.stats.away;
  const totalControl = home.controlledBallSeconds + away.controlledBallSeconds;
  return {
    goals: match.homeScore + match.awayScore,
    shots: home.shots + away.shots,
    shotsOnTarget: home.shotsOnTarget + away.shotsOnTarget,
    xg: home.xG + away.xG,
    corners: home.corners + away.corners,
    fouls: home.fouls + away.fouls,
    yellows: home.yellows + away.yellows,
    reds: home.reds + away.reds,
    straightReds: match.events.filter((event) => event.type === EVENT_CODES.RED).length,
    secondYellowReds: match.events.filter((event) => event.type === EVENT_CODES.YELLOW_RED).length,
    passes: home.passes + away.passes,
    injuries: home.injuries + away.injuries,
    homePossession: totalControl > 0 ? home.controlledBallSeconds / totalControl * 100 : 50,
    homeGoals: match.homeScore,
    awayGoals: match.awayScore,
    homeXg: home.xG,
    awayXg: away.xG,
    homeShots: home.shots,
    awayShots: away.shots,
    homePasses: home.passes,
    awayPasses: away.passes,
    homeTurnovers: home.turnovers,
    awayTurnovers: away.turnovers,
    homeCorners: home.corners,
    awayCorners: away.corners,
    homeMeanEnergy: run.homeMeanEnergy,
    awayMeanEnergy: run.awayMeanEnergy,
    homeMeanLoad: run.homeMeanLoad,
    awayMeanLoad: run.awayMeanLoad,
    diagnostics: match.simulationDiagnostics ?? null,
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function summarize(name: string, values: Sample[]): Summary {
  const keys = [
    "goals", "shots", "shotsOnTarget", "xg", "corners", "fouls", "yellows", "reds", "straightReds",
    "secondYellowReds", "passes", "injuries", "homePossession", "homeXg", "awayXg", "homeShots", "awayShots",
    "homePasses", "awayPasses", "homeTurnovers", "awayTurnovers", "homeCorners", "awayCorners", "homeMeanEnergy",
    "awayMeanEnergy", "homeMeanLoad", "awayMeanLoad",
  ] as const;
  if (values.length === 0) throw new Error(`${name}: cannot summarize zero samples`);
  const means: Record<string, number> = {};
  const percentiles: Record<string, [number, number, number]> = {};
  for (const key of keys) {
    const metric = values.map((value) => value[key]);
    means[key] = mean(metric);
    percentiles[key] = [percentile(metric, 0.05), percentile(metric, 0.5), percentile(metric, 0.95)];
  }
  const counts = { home: 0, draw: 0, away: 0 };
  const goalHistogram: Record<number, number> = {};
  for (const value of values) {
    if (value.homeGoals > value.awayGoals) counts.home++;
    else if (value.homeGoals < value.awayGoals) counts.away++;
    else counts.draw++;
    goalHistogram[value.goals] = (goalHistogram[value.goals] ?? 0) + 1;
  }
  const result = {
    home: counts.home / values.length,
    draw: counts.draw / values.length,
    away: counts.away / values.length,
  };
  if (Math.abs(result.home + result.draw + result.away - 1) > 1e-9) throw new Error(`${name}: H/D/A does not sum to 100%`);
  return { name, count: values.length, means, percentiles, result, goalHistogram };
}

function run(name: string, index: number): CalibrationRun {
  if (name === "neutral-baseline") return full(index, 55, 55);
  if (name === "identical-home-away") return full(index, 55, 55, tactics(0), tactics(0), 100, false);
  if (name === "P10-vs-P50-neutral") return full(index, 42, 55);
  if (name === "P25-vs-P50-neutral") return full(index, 49, 55);
  if (name === "P50-vs-P50-neutral") return full(index, 55, 55);
  if (name === "P75-vs-P50-neutral") return full(index, 61, 55);
  if (name === "P90-vs-P50-neutral") return full(index, 68, 55);
  if (name === "P10-vs-P90-neutral") return full(index, 42, 68);
  if (name === "P90-vs-P10-neutral") return full(index, 68, 42);

  const tacticsMatch = /^tactics-(CONTROL|PRESS|COUNTER)-vs-(CONTROL|PRESS|COUNTER)$/.exec(name);
  if (tacticsMatch) {
    const homeStyle = STYLES[tacticsMatch[1]];
    const awayStyle = STYLES[tacticsMatch[2]];
    return full(index, 55, 55, tactics(homeStyle, homeStyle === 1 ? 2 : 0), tactics(awayStyle, awayStyle === 1 ? 2 : 0));
  }

  const equalFamiliarity = /^familiarity-(CONTROL|PRESS|COUNTER)-equal-(\d+)$/.exec(name);
  if (equalFamiliarity) {
    const style = STYLES[equalFamiliarity[1]];
    const familiarity = Number(equalFamiliarity[2]);
    const selected = tactics(style, style === 1 ? 2 : 0);
    return full(index, 55, 55, selected, selected, 100, true, false, familiarity, familiarity);
  }

  const gapFamiliarity = /^familiarity-(CONTROL|PRESS|COUNTER)-home-(\d+)-away-(\d+)$/.exec(name);
  if (gapFamiliarity) {
    const style = STYLES[gapFamiliarity[1]];
    const selected = tactics(style, style === 1 ? 2 : 0);
    return full(index, 55, 55, selected, selected, 100, true, false, Number(gapFamiliarity[2]), Number(gapFamiliarity[3]));
  }

  if (name.startsWith("energy-")) return full(index, 55, 55, tactics(0), tactics(0), Number(name.slice(7)));
  if (name === "out-of-position") return full(index, 55, 55, tactics(0), tactics(0), 100, true, true);
  if (name === "minute-60-substitution") return segmentedAvailability(index, 60, 0, "AVERAGE", true);

  const zeroLoss = /^player-loss-0-minute-(\d+)$/.exec(name);
  if (zeroLoss) return segmentedAvailability(index, Number(zeroLoss[1]), 0);
  const averageLoss = /^player-loss-([123])-average-minute-(\d+)$/.exec(name);
  if (averageLoss) return segmentedAvailability(index, Number(averageLoss[2]), Number(averageLoss[1]));
  const roleLoss = /^player-loss-1-(CB|WIDE|CM|ATT)-minute-(\d+)$/.exec(name);
  if (roleLoss) return segmentedAvailability(index, Number(roleLoss[2]), 1, roleLoss[1] as "CB" | "WIDE" | "CM" | "ATT");
  throw new Error(`Unknown scenario ${name}`);
}

const CORE_SCENARIOS = [
  "neutral-baseline",
  "P10-vs-P50-neutral",
  "P25-vs-P50-neutral",
  "P50-vs-P50-neutral",
  "P75-vs-P50-neutral",
  "P90-vs-P50-neutral",
  "P10-vs-P90-neutral",
  "P90-vs-P10-neutral",
  "identical-home-away",
  ...Object.keys(STYLES).flatMap((home) => Object.keys(STYLES).map((away) => `tactics-${home}-vs-${away}`)),
  "energy-100",
  "energy-75",
  "energy-50",
  "out-of-position",
  "minute-60-substitution",
];
const FAMILIARITY_SCENARIOS = [
  ...Object.keys(STYLES).flatMap((style) => FAMILIARITY_LEVELS.map((value) => `familiarity-${style}-equal-${value}`)),
  ...Object.keys(STYLES).flatMap((style) => [[75, 50], [50, 75], [90, 50], [50, 90]].map(([home, away]) => `familiarity-${style}-home-${home}-away-${away}`)),
];
const PLAYER_LOSS_SCENARIOS = [
  ...LOSS_MINUTES.map((minute) => `player-loss-0-minute-${minute}`),
  ...LOSS_MINUTES.map((minute) => `player-loss-1-average-minute-${minute}`),
  ...[30, 60].flatMap((minute) => ["CB", "WIDE", "CM"].map((role) => `player-loss-1-${role}-minute-${minute}`)),
  ...[30, 60].flatMap((minute) => [2, 3].map((count) => `player-loss-${count}-average-minute-${minute}`)),
];
const ALL = [...CORE_SCENARIOS, ...FAMILIARITY_SCENARIOS, ...PLAYER_LOSS_SCENARIOS];

function snapshot(): Record<string, unknown> {
  const config = MATCH_SIMULATOR_CONFIG;
  return {
    influence: (TARGETS.tacticalFamiliarity as { latentInfluenceContract: unknown }).latentInfluenceContract,
    tacticalFamiliarity: config.tacticalFamiliarity,
    numericalDisadvantage: config.numericalDisadvantage,
    localDensity: {
      actionQualityCoefficient: config.actionQuality.localDensityCoefficient,
      shotCoefficient: config.shotModel.localDensityCoefficient,
    },
    foulMultiplier: config.probabilityModel.foulProbabilityCalibrationMultiplier,
    shotOnTarget: config.shotModel.shotsOnTarget,
    homeAdvantage: config.homeAdvantage,
    normalization: config.normalization,
    cards: config.cards,
    timing: { tempoScale: config.timing.tempoScale, regulationSeconds: config.timing.regulationSeconds },
    tacticalActionMix: config.tacticalActionMix,
    xgGlobal: config.shotModel.xgLookup.GLOBAL.GLOBAL,
  };
}

function main(): void {
  applyOverrides();
  const requested = process.env.MATCH_SIM_ONLY ?? "neutral-baseline";
  const names = requested === "all" ? ALL : [requested];
  if (process.env.MATCH_SIM_DRY_RUN === "1") {
    process.stdout.write(JSON.stringify({ status: "dry-run-no-simulations", targets: TARGET_PATH, scenarios: names }, null, 2));
    return;
  }
  const baselineCount = Number(process.env.MATCH_SIM_BASELINE_COUNT ?? 20000);
  const scenarioCount = Number(process.env.MATCH_SIM_COUNT ?? 5000);
  if (!Number.isInteger(baselineCount) || baselineCount <= 0) throw new Error(`invalid baseline simulation count: ${baselineCount}`);
  if (!Number.isInteger(scenarioCount) || scenarioCount <= 0) throw new Error(`invalid scenario simulation count: ${scenarioCount}`);
  const start = Number(process.env.MATCH_SIM_START ?? 0);
  const raw: Record<string, Sample[]> = {};
  const results: Summary[] = [];
  for (const name of names) {
    raw[name] = [];
    const total = name === "neutral-baseline" ? baselineCount : scenarioCount;
    for (let index = 0; index < total; index++) raw[name].push(sample(run(name, start + index)));
    results.push(summarize(name, raw[name]));
  }
  const output = process.env.MATCH_SIM_OUTPUT ?? CANDIDATE_JSON;
  const artifact = {
    artifactStatus: "CANDIDATE_NOT_AUTHORITATIVE",
    targetSchemaVersion: TARGETS.schemaVersion,
    seed: SEED,
    sampleCounts: { baseline: baselineCount, scenario: scenarioCount },
    config: snapshot(),
    results,
    raw,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(artifact, null, 2));
  process.stdout.write(JSON.stringify(results));
}

main();
