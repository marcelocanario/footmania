import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySavedLineup } from "../src/game/club";
import { EVENT_CODES } from "../src/game/constants";
import { setupKey } from "../src/game/familiarity";
import { createLiveMatchState, performLiveSub, simulateMatch, tickLiveMatch } from "../src/game/match";
import { generateSeniorPlayer, generateYouthPlayer, seniorRosterTemplate } from "../src/game/playerGeneration";
import { overallFromSkills } from "../src/game/rating";
import { createRng } from "../src/game/rng";
import type { Club, LiveMatchState, Match, MatchSimulationDiagnostics, Player, Tactics } from "../src/game/types";
import { NATURAL_POSITIONS, positionGroup, type DeployedRole, type NaturalPosition } from "../src/game/positions";
import { tryDeployedRoleForSlot } from "../src/game/matchSim";
import { gameConfig } from "../src/config";
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
// A standard generated 30-man squad at broad-group level (3 GK / 4 FB / 5 CB /
// 10 MF / 8 FW), split into the nine natural positions.
const POSITIONS: NaturalPosition[] = [
  "GK", "GK", "GK",
  "LB", "LB", "RB", "RB",
  "CB", "CB", "CB", "CB", "CB",
  "DM", "DM", "DM", "DM", "DM", "AM", "AM", "AM", "AM", "AM",
  "LW", "LW", "RW", "RW", "ST", "ST", "ST", "ST",
];
const STYLES: Record<string, number> = { CONTROL: 0, PRESS: 1, COUNTER: 2 };
const FAMILIARITY_LEVELS = [25, 50, 75, 90, 100];
const LOSS_MINUTES = [15, 30, 45, 60, 75];
const INPUT_MODE = process.env.MATCH_SIM_INPUT_MODE === "generated" ? "generated" : "synthetic";
const GENERATED_CLUBS_PER_DIVISION = Number(process.env.MATCH_SIM_GENERATED_CLUBS_PER_DIVISION ?? 12);
const GENERATED_TOTAL_DIVISIONS = 5;
const GENERATED_REFERENCE_DIVISION = Number(process.env.MATCH_SIM_GENERATED_DIVISION ?? 1);
const HARNESS_VERSION = "match-calibration-next-v3-controlled-familiarity";

type GeneratedPopulation = {
  players: Player[];
  clubsByDivision: Map<number, Club[]>;
  xiMeans: Map<number, number>;
  summary: Record<string, unknown>;
};

let generatedPopulation: GeneratedPopulation | null = null;

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

function cloneClubState(source: Club, id = source.id): Club {
  return {
    ...source,
    id,
    tactics: { ...source.tactics },
    tacticFamiliarity: source.tacticFamiliarity
      ? Object.fromEntries(Object.entries(source.tacticFamiliarity).map(([key, value]) => [key, { ...value }]))
      : undefined,
    savedLineup: source.savedLineup
      ? {
          ...source.savedLineup,
          starters: [...source.savedLineup.starters],
          subs: [...source.savedLineup.subs],
        }
      : null,
    ledger: {
      income: [...source.ledger.income],
      expense: [...source.ledger.expense],
    },
    trophies: { ...source.trophies },
  };
}

function startingXi(squad: Player[]): Player[] {
  // §13.4/§13.5 reporting shape: the fixed 4-3-3 natural-position XI.
  const shape: [NaturalPosition, number][] = [
    ["GK", 1], ["LB", 1], ["RB", 1], ["CB", 2], ["DM", 1], ["AM", 2], ["LW", 1], ["RW", 1], ["ST", 1],
  ];
  const xi: Player[] = [];
  for (const [position, count] of shape) {
    xi.push(
      ...squad
        .filter((player) => player.position === position)
        .sort((a, b) => b.overall - a.overall || a.id - b.id)
        .slice(0, count),
    );
  }
  return xi;
}

function buildGeneratedPopulation(seed: number): GeneratedPopulation {
  if (!Number.isInteger(GENERATED_CLUBS_PER_DIVISION) || GENERATED_CLUBS_PER_DIVISION < 2) {
    throw new Error(`MATCH_SIM_GENERATED_CLUBS_PER_DIVISION must be an integer >= 2: ${GENERATED_CLUBS_PER_DIVISION}`);
  }
  if (!Number.isInteger(GENERATED_REFERENCE_DIVISION) || GENERATED_REFERENCE_DIVISION < 1 || GENERATED_REFERENCE_DIVISION > GENERATED_TOTAL_DIVISIONS) {
    throw new Error(`MATCH_SIM_GENERATED_DIVISION must be an integer from 1 to ${GENERATED_TOTAL_DIVISIONS}: ${GENERATED_REFERENCE_DIVISION}`);
  }
  const players: Player[] = [];
  const clubsByDivision = new Map<number, Club[]>();
  const xiMeans = new Map<number, number>();
  const seniorTemplate = seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize);
  const academyRules = gameConfig.playerGenerationRules;
  const academyAgeSpan = academyRules.academyMaxAge - academyRules.academyMinAge + 1;

  for (let division = 1; division <= GENERATED_TOTAL_DIVISIONS; division++) {
    const clubs: Club[] = [];
    for (let clubIndex = 0; clubIndex < GENERATED_CLUBS_PER_DIVISION; clubIndex++) {
      const clubId = 100_000 + division * 1_000 + clubIndex;
      const generatedClub = club(clubId, tactics(0));
      generatedClub.name = `Generated D${division} Club ${clubIndex + 1}`;
      generatedClub.shortName = `G${division}-${clubIndex + 1}`;
      generatedClub.highestDivision = division;
      const seniors = seniorTemplate.map((position, slot) =>
        generateSeniorPlayer({
          id: clubId * 1_000 + slot + 1,
          clubId,
          country: generatedClub.country,
          position,
          isYouth: false,
          currentDivision: division,
          highestDivisionReached: division,
          totalDivisions: GENERATED_TOTAL_DIVISIONS,
          seasonId: 1,
          generationType: "initial-senior",
          seed,
          slot,
        }),
      );
      const academy = Array.from({ length: academyRules.initialAcademySize }, (_, slot) =>
        generateYouthPlayer({
          id: clubId * 1_000 + 100 + slot + 1,
          clubId,
          country: generatedClub.country,
          position: NATURAL_POSITIONS[slot % NATURAL_POSITIONS.length],
          age: academyRules.academyMinAge + (slot % academyAgeSpan),
          isYouth: true,
          currentDivision: division,
          highestDivisionReached: division,
          totalDivisions: GENERATED_TOTAL_DIVISIONS,
          seasonId: 1,
          generationType: "initial-academy",
          seed,
          slot,
        }),
      );
      generatedClub.captainId = seniors.find((player) => player.position === "GK")?.id ?? null;
      generatedClub.penaltyTakerId = seniors.find((player) => player.position === "ST")?.id ?? null;
      players.push(...seniors, ...academy);
      clubs.push(generatedClub);
      xiMeans.set(clubId, mean(startingXi(seniors).map((player) => player.overall)));
    }
    clubsByDivision.set(division, clubs);
  }

  const seniorPlayers = players.filter((player) => !player.isYouth);
  const academyPlayers = players.filter((player) => player.isYouth);
  const seniorOveralls = seniorPlayers.map((player) => player.overall).sort((a, b) => a - b);
  const allOveralls = players.map((player) => player.overall).sort((a, b) => a - b);
  const divisionMeans = Object.fromEntries(
    [...clubsByDivision.entries()].map(([division, clubs]) => [
      `D${division}`,
      mean(seniorPlayers.filter((player) => clubs.some((candidate) => candidate.id === player.clubId)).map((player) => player.overall)),
    ]),
  );
  const d1Xi = (clubsByDivision.get(1) ?? []).map((candidate) => xiMeans.get(candidate.id) ?? 0);
  const summary: Record<string, unknown> = {
    source: "production generateSeniorPlayer/generateYouthPlayer",
    seed,
    totalDivisions: GENERATED_TOTAL_DIVISIONS,
    clubsPerDivision: GENERATED_CLUBS_PER_DIVISION,
    referenceDivision: GENERATED_REFERENCE_DIVISION,
    totalClubs: GENERATED_TOTAL_DIVISIONS * GENERATED_CLUBS_PER_DIVISION,
    totalPlayers: players.length,
    seniorPlayers: seniorPlayers.length,
    academyPlayers: academyPlayers.length,
    seniorOverallMean: mean(seniorOveralls),
    seniorOverallP10: percentile(seniorOveralls, 0.1),
    seniorOverallP50: percentile(seniorOveralls, 0.5),
    seniorOverallP90: percentile(seniorOveralls, 0.9),
    allPlayerMean: mean(allOveralls),
    divisionMeans,
    d1XiMean: mean(d1Xi),
    d1XiP10: percentile([...d1Xi].sort((a, b) => a - b), 0.1),
    d1XiP50: percentile([...d1Xi].sort((a, b) => a - b), 0.5),
    d1XiP90: percentile([...d1Xi].sort((a, b) => a - b), 0.9),
  };
  return { players, clubsByDivision, xiMeans, summary };
}

function makePlayer(id: number, clubId: number, position: NaturalPosition, strength: number, energy: number): Player {
  const group = positionGroup(position);
  const base = Math.max(1, Math.min(99, strength + (group === "FB" ? 1 : group === "FW" ? 2 : 0)));
  const skills = {
    gol: Math.max(1, Math.min(99, base + (group === "GK" ? 5 : -8))),
    pace: base,
    tec: base,
    pas: base + (group === "MF" ? 2 : 0),
    des: base + (group === "GK" || group === "FB" || group === "CB" ? 3 : -2),
    playmaking: base + (group === "CB" ? 3 : 0),
    fin: base + (group === "FW" ? 5 : -3),
  };
  return {
    id,
    name: `P${id}`,
    country: "BRA",
    age: 25,
    position,
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

function generatedStrengthPercentile(strength: number): number {
  const anchors: Array<[number, number]> = [[42, 0.1], [49, 0.25], [55, 0.5], [61, 0.75], [68, 0.9]];
  return anchors.reduce((best, candidate) =>
    Math.abs(candidate[0] - strength) < Math.abs(best[0] - strength) ? candidate : best,
  )[1];
}

function generatedClubForStrength(strength: number, offset = 0): Club {
  if (!generatedPopulation) throw new Error("Generated match population has not been initialized");
  const referenceClubs = generatedPopulation.clubsByDivision.get(GENERATED_REFERENCE_DIVISION) ?? [];
  const ordered = [...referenceClubs].sort((a, b) =>
    (generatedPopulation!.xiMeans.get(a.id) ?? 0) - (generatedPopulation!.xiMeans.get(b.id) ?? 0) || a.id - b.id,
  );
  const target = Math.round((ordered.length - 1) * generatedStrengthPercentile(strength));
  return ordered[(target + offset + ordered.length) % ordered.length];
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
  identicalTeams = false,
  aiTactics = true,
) {
  if (INPUT_MODE === "generated") {
    if (!generatedPopulation) throw new Error("Generated match population has not been initialized");
    const homeTemplate = generatedClubForStrength(homeStrength);
    const awayTemplate = identicalTeams
      ? homeTemplate
      : generatedClubForStrength(awayStrength, homeStrength === awayStrength ? 1 : 0);
    const home = cloneClubState(homeTemplate);
    const away = identicalTeams ? cloneClubState(homeTemplate, homeTemplate.id + 90_000_000) : cloneClubState(awayTemplate);
    if (!aiTactics) {
      home.isHuman = true;
      away.isHuman = true;
    }
    home.tactics = { ...homeTactics };
    away.tactics = { ...awayTactics };
    seedFamiliarity(home, homeFamiliarity);
    seedFamiliarity(away, awayFamiliarity);
    const players = clone(generatedPopulation.players);
    for (const player of players) {
      if (player.clubId === home.id || player.clubId === away.id) player.energy = energy;
    }
    if (identicalTeams) {
      const clonedHomePlayers = players
        .filter((player) => player.clubId === home.id)
        .map((player) => ({ ...player, id: player.id + 90_000_000, clubId: away.id }));
      players.push(...clonedHomePlayers);
    }
    if (outOfPosition) {
      const homePlayers = players.filter((player) => player.clubId === home.id);
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
    return { home, away, players, seed: SEED + index * 7919 };
  }
  const home = club(1, homeTactics);
  const away = club(2, awayTactics);
  if (!aiTactics) {
    home.isHuman = true;
    away.isHuman = true;
  }
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
  identicalTeams = false,
  aiTactics = true,
): CalibrationRun {
  const setup = pair(index, homeStrength, awayStrength, homeTactics, awayTactics, energy, outOfPosition, homeFamiliarity, awayFamiliarity, identicalTeams, aiTactics);
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

/**
 * Calibration REPORT bucket for a deployed role. These four bucket names
 * ("CB"/"WIDE"/"CM"/"ATT") are scenario labels baked into the stored
 * calibration targets — they are not deployed roles, and "CM" here means
 * "central midfield band", not the removed CM role.
 */
function calibrationRole(role: DeployedRole): "GK" | "CB" | "WIDE" | "CM" | "ATT" {
  if (role === "GK") return "GK";
  if (role === "LB" || role === "RB" || role === "LW" || role === "RW") return "WIDE";
  if (role === "ST") return "ATT";
  if (role === "CB") return "CB";
  return "CM";
}

function selectedLossIds(
  index: number,
  state: LiveMatchState,
  players: Player[],
  count: number,
  requestedRole: "AVERAGE" | "CB" | "WIDE" | "CM" | "ATT",
): number[] {
  if (count === 0) return [];
  const byId = new Map(players.map((player) => [player.id, player]));
  // §9.1: the deployed role comes from the live slot map, never from the player.
  const slotOf = (id: number) => state.homeSlotByPlayerId?.[id] ?? Number.MAX_SAFE_INTEGER;
  const roleOf = (id: number) =>
    tryDeployedRoleForSlot(state.homeSlotByPlayerId, state.homeTactics.formation, id)?.role ?? "DM";
  const outfield = state.homeOn
    .map((id) => byId.get(id))
    .filter((player): player is Player => Boolean(player) && calibrationRole(roleOf(player!.id)) !== "GK")
    .sort((a, b) => slotOf(a.id) - slotOf(b.id) || a.id - b.id);
  const pool = requestedRole === "AVERAGE" ? outfield : outfield.filter((player) => calibrationRole(roleOf(player.id)) === requestedRole);
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
  // Loss controls must share the fixed identical-team/control setup used by
  // the neutrality gate; AI tactic selection would otherwise be confounded
  // with the measured effect of the missing player.
  const setup = pair(index, 55, 55, tactics(0), tactics(0), 100, false, 50, 50, true, false);
  const players = clone(setup.players);
  const rng = createRng(setup.seed);
  const state = createLiveMatchState(rng, setup.home, setup.away, players, {
    matchId: index,
    competitionId: 1,
    fixtureId: index,
    homeNeutral: true,
  });
  // Match calibration must use the same one-minute engine cadence as
  // simulateMatch. A single large tick consumes a different possession/RNG
  // path, so even a nominal zero-loss control would not be a paired no-op.
  const advanceNominalMinutes = (count: number) => {
    for (let elapsed = 0; elapsed < count && !state.ended; elapsed++) {
      tickLiveMatch(rng, setup.home, setup.away, players, state, 1, { ignoreHalfTime: true });
    }
  };
  advanceNominalMinutes(minute);
  const losses = selectedLossIds(index, state, players, substitute ? 1 : lossCount, role);
  if (substitute) {
    performLiveSub(rng, setup.home, setup.away, players, state, 0, losses[0], state.homeSubs[0]);
  } else if (losses.length > 0) {
    const removed = new Set(losses);
    state.homeOn = state.homeOn.filter((id) => !removed.has(id));
    state.homeXI = state.homeXI.filter((id) => !removed.has(id));
    // These scenarios represent a permanent departure with no replacement
    // available. Clear the remaining bench after the departure so routine AI
    // substitutions cannot silently turn a loss into a normal substitution.
    state.homeSubs = [];
  }
  advanceNominalMinutes(90 - minute);
  // Added time is frozen by the engine during the second half. Continue the
  // same one-minute cadence until the match actually ends rather than
  // truncating the calibration sample at nominal 90 minutes.
  let guard = 0;
  while (!state.ended && guard++ < 120) advanceNominalMinutes(1);
  if (!state.ended) throw new Error(`Segmented calibration match ${index} did not finish`);
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
  // Explicit neutral identical-team control. `identical-home-away` is a
  // separate home-advantage control and intentionally runs at a non-neutral
  // venue; this scenario is the production-generated counterpart of the
  // equal-side familiarity neutrality gate.
  if (name === "identical-neutral") return full(index, 55, 55, tactics(0), tactics(0), 100, true, false, 50, 50, true, false);
  if (name === "identical-home-away") return full(index, 55, 55, tactics(0), tactics(0), 100, false, false, 50, 50, true);
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
    return full(
      index,
      55,
      55,
      tactics(homeStyle, homeStyle === 1 ? 2 : 0),
      tactics(awayStyle, awayStyle === 1 ? 2 : 0),
      100,
      true,
      false,
      50,
      50,
      true,
      false,
    );
  }

  const equalFamiliarity = /^familiarity-(CONTROL|PRESS|COUNTER)-equal-(\d+)$/.exec(name);
  if (equalFamiliarity) {
    const style = STYLES[equalFamiliarity[1]];
    const familiarity = Number(equalFamiliarity[2]);
    const selected = tactics(style, style === 1 ? 2 : 0);
    return full(index, 55, 55, selected, selected, 100, true, false, familiarity, familiarity, true, false);
  }

  const gapFamiliarity = /^familiarity-(CONTROL|PRESS|COUNTER)-home-(\d+)-away-(\d+)$/.exec(name);
  if (gapFamiliarity) {
    const style = STYLES[gapFamiliarity[1]];
    const selected = tactics(style, style === 1 ? 2 : 0);
    return full(index, 55, 55, selected, selected, 100, true, false, Number(gapFamiliarity[2]), Number(gapFamiliarity[3]), true, false);
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
  "identical-neutral",
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

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableJsonValue(nested)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableJsonValue(value))).digest("hex");
}

function inputSnapshot(names: string[]): Record<string, unknown> {
  return {
    harnessVersion: HARNESS_VERSION,
    inputMode: INPUT_MODE,
    seed: SEED,
    scenarios: names,
    generatedPopulation: generatedPopulation?.summary ?? null,
    targetContract: TARGETS,
    gameConfig: {
      playerGeneration: gameConfig.playerGeneration,
      playerCareer: gameConfig.playerCareer,
      playerGenerationRules: gameConfig.playerGenerationRules,
    },
    matchSimulatorConfig: MATCH_SIMULATOR_CONFIG,
  };
}

function snapshot(): Record<string, unknown> {
  const config = MATCH_SIMULATOR_CONFIG;
  return {
    influence: (TARGETS.tacticalFamiliarity as { latentInfluenceContract: unknown }).latentInfluenceContract,
    tacticalFamiliarity: config.tacticalFamiliarity,
    numericalDisadvantage: config.numericalDisadvantage,
    localDensity: {
      actionQualityCoefficient: config.actionQuality.localDensityCoefficient,
      passActionQualityCoefficient: config.actionQuality.passLocalDensityCoefficient,
      shotCoefficient: config.shotModel.localDensityCoefficient,
    },
    foulMultiplier: config.probabilityModel.foulProbabilityCalibrationMultiplier,
    cornerRateMultiplier: config.probabilityModel.cornerRateCalibrationMultiplier,
    shotOnTarget: config.shotModel.shotsOnTarget,
    finisherVsGoalkeeperLogitCoefficient: config.shotModel.finisherVsGoalkeeperLogitCoefficient,
    playmakingProgressionCoefficient: config.actionQuality.playmakingProgressionCoefficient,
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
  const names = requested === "all"
    ? ALL
    : requested.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("MATCH_SIM_ONLY must contain at least one scenario name");
  if (INPUT_MODE === "generated") generatedPopulation = buildGeneratedPopulation(SEED);
  if (process.env.MATCH_SIM_DRY_RUN === "1") {
    const frozen = inputSnapshot(names);
    process.stdout.write(JSON.stringify({
      status: "dry-run-no-simulations",
      targets: TARGET_PATH,
      scenarios: names,
      inputDigest: digest(frozen),
      inputMode: INPUT_MODE,
      generatedPopulation: generatedPopulation?.summary ?? null,
    }, null, 2));
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
  const frozen = inputSnapshot(names);
  const artifact = {
    artifactStatus: "CANDIDATE_NOT_AUTHORITATIVE",
    harnessVersion: HARNESS_VERSION,
    inputMode: INPUT_MODE,
    targetSchemaVersion: TARGETS.schemaVersion,
    seed: SEED,
    sampleCounts: { baseline: baselineCount, scenario: scenarioCount },
    inputDigest: digest(frozen),
    inputSnapshot: frozen,
    generatedPopulation: generatedPopulation?.summary ?? null,
    config: snapshot(),
    results,
    raw,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(artifact, null, 2));
  process.stdout.write(JSON.stringify(results));
}

main();
