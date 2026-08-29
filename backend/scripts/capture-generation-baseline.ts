import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerNamePool } from "../src/game/names";
import { readNamePoolsArtifact } from "../src/services/namePoolService";
import { createRng } from "../src/game/rng";
import {
  generateSkillsForTarget,
  generateSeniorPlayer,
  generateYouthPlayer,
  seniorRosterTemplate,
  type GeneratePlayerContext,
} from "../src/game/playerGeneration";
import { overallFromSkills } from "../src/game/rating";
import { simulateMatch, createLiveMatchState, tickLiveMatch, performLiveSub } from "../src/game/match";
import type { Club, MatchEvent, Player, TeamMatchStats, Tactics } from "../src/game/types";
import { NATURAL_POSITIONS, type NaturalPosition } from "../src/game/positions";

/**
 * One-shot baseline capture for the characteristic-removal neutrality contract.
 *
 * Run BEFORE any generator change (plans instruction §15.1): it freezes the
 * current implementation's fixed-seed output into a checked-in golden fixture.
 * After the refactor, tests/generationGolden.test.ts requires exact equality
 * against this file (skill tolerance 0, overall tolerance 0).
 *
 * Usage: npx tsx scripts/capture-generation-baseline.ts
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "..", "tests", "fixtures", "generation-golden.json");

// Same catalog source as tests/setup.ts so generated names are identical
// between the capture run and the vitest run.
const artifact = readNamePoolsArtifact();
for (const [code, pools] of Object.entries(artifact.countries)) {
  registerNamePool("names", code, pools.names);
  registerNamePool("surnames", code, pools.surnames);
}

// ---------------------------------------------------------------------------
// §15.1 fixed-seed generator oracle
// ---------------------------------------------------------------------------

const POSITIONS: NaturalPosition[] = [...NATURAL_POSITIONS];
const TARGETS = [1, 20, 40, 55, 60, 73, 85, 99, 100];
const SEEDS_PER_CASE = 256;
const SKILL_ORDER = ["gol", "pace", "tec", "pas", "des", "playmaking", "fin"] as const;

type OracleRow = [NaturalPosition, ...number[]];

const oracle: OracleRow[] = [];
for (const position of POSITIONS) {
  for (const target of TARGETS) {
    for (let i = 0; i < SEEDS_PER_CASE; i++) {
      const seed = NATURAL_POSITIONS.indexOf(position) * 10_000_000 + target * 100_000 + i;
      const { skills } = generateSkillsForTarget(createRng(seed), position, target);
      oracle.push([
        position,
        target,
        seed,
        ...SKILL_ORDER.map((k) => skills[k]),
        overallFromSkills(position, skills),
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// §15.2 complete generated-player equality dumps
// ---------------------------------------------------------------------------

function seniorCtx(overrides: Partial<GeneratePlayerContext>): GeneratePlayerContext {
  return {
    id: 1,
    clubId: 10,
    country: "BRA",
    position: "DM",
    isYouth: false,
    currentDivision: 1,
    highestDivisionReached: 1,
    totalDivisions: 5,
    seasonId: 1,
    generationType: "initial-senior",
    seed: 42,
    slot: 0,
    ...overrides,
  };
}

function youthCtx(overrides: Partial<GeneratePlayerContext>): GeneratePlayerContext {
  return {
    id: 1,
    clubId: 10,
    country: "BRA",
    position: "DM",
    age: 16,
    isYouth: true,
    currentDivision: 1,
    highestDivisionReached: 1,
    totalDivisions: 5,
    seasonId: 1,
    generationType: "initial-academy",
    seed: 42,
    slot: 0,
    ...overrides,
  };
}

const template = seniorRosterTemplate(28);
const seniorPlayers: unknown[] = [];
for (const division of [1, 3]) {
  for (let slot = 0; slot < 28; slot++) {
    seniorPlayers.push(
      generateSeniorPlayer(seniorCtx({
        id: slot + 1,
        clubId: 100 + division,
        position: template[slot],
        currentDivision: division,
        highestDivisionReached: division,
        seed: 4200 + division,
        slot,
      })),
    );
  }
}

const youthPlayers: unknown[] = [];
const pedigrees: [number, number][] = [[1, 1], [4, 2], [5, 5]];
let youthIndex = 0;
for (const [current, highest] of pedigrees) {
  for (let slot = 0; slot < 20; slot++) {
    youthPlayers.push(
      generateYouthPlayer(youthCtx({
        id: 500 + youthIndex,
        clubId: 300 + current * 10 + highest,
        position: NATURAL_POSITIONS[slot % NATURAL_POSITIONS.length],
        age: 16 + (slot % 4),
        currentDivision: current,
        highestDivisionReached: highest,
        seed: 9000 + youthIndex,
        slot,
      })),
    );
    youthIndex++;
  }
}

// ---------------------------------------------------------------------------
// §15.5 fixed-seed match regression digests
// ---------------------------------------------------------------------------

function matchClub(id: number, tactics: Tactics): Club {
  return {
    id,
    name: id === 1 ? "Golden Home" : "Golden Away",
    shortName: id === 1 ? "GH" : "GA",
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
    tactics,
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    savedLineup: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

// A standard generated 30-man squad at broad-group level (3 GK / 4 FB / 5 CB /
// 10 MF / 8 FW), split into the nine natural positions.
const MATCH_POSITIONS: NaturalPosition[] = [
  "GK", "GK", "GK",
  "LB", "LB", "RB", "RB",
  "CB", "CB", "CB", "CB", "CB",
  "DM", "DM", "DM", "DM", "DM", "AM", "AM", "AM", "AM", "AM",
  "LW", "LW", "RW", "RW", "ST", "ST", "ST", "ST",
];

function generatedSquad(clubId: number, division: number, seedBase: number, offset: number): Player[] {
  return MATCH_POSITIONS.map((position, i) =>
    generateSeniorPlayer(seniorCtx({
      id: offset + i + 1,
      clubId,
      country: "BRA",
      position,
      currentDivision: division,
      highestDivisionReached: division,
      seasonId: null,
      generationType: "initial-senior",
      seed: seedBase,
      slot: i,
    })),
  );
}

function clonePlayers(players: Player[]): Player[] {
  return players.map((p) => ({ ...p, skills: { ...p.skills }, skillAcc: [...p.skillAcc], recentMinutes: [...p.recentMinutes], careerProfile: { ...p.careerProfile } }));
}

function energyMap(players: Player[]): Record<number, number> {
  const map: Record<number, number> = {};
  for (const p of players) map[p.id] = p.energy;
  return map;
}

interface InstantDigest {
  homeXI: number[];
  awayXI: number[];
  homeSubs: number[];
  awaySubs: number[];
  homeScore: number;
  awayScore: number;
  penaltyWinnerId: number | null;
  extraTime: boolean;
  events: MatchEvent[];
  stats: { home: TeamMatchStats; away: TeamMatchStats };
  minutes: Record<number, number>;
  postEnergy: Record<number, number>;
  rngState: number;
}

interface LineupSnapshot {
  homeXI: number[];
  awayXI: number[];
  homeSubs: number[];
  awaySubs: number[];
}

function digestInstant(
  match: ReturnType<typeof simulateMatch>["match"],
  players: Player[],
  lineup: LineupSnapshot,
  rng: { state: number },
): InstantDigest {
  return {
    ...lineup,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    penaltyWinnerId: match.penaltyWinnerId ?? null,
    extraTime: match.extraTime ?? false,
    events: match.events,
    stats: match.stats,
    minutes: match.minutes ?? {},
    postEnergy: energyMap(players),
    rngState: rng.state,
  };
}

function tactics(style: number, pressing = 0): Tactics {
  void pressing;
  return { formation: 4, style, pressing, direction: 0 };
}

const homeClub = matchClub(1, tactics(0));
const awayClub = matchClub(2, tactics(2));
const homeSquad = generatedSquad(1, 1, 31111, 1000);
const awaySquad = generatedSquad(2, 4, 32222, 2000);
let instantNeutralDigest: InstantDigest;
let instantTacticsDigest: InstantDigest;

// Instant neutral: equal-strength squads.
{
  const home = matchClub(1, tactics(0));
  const away = matchClub(2, tactics(0));
  const lineupState = createLiveMatchState(createRng(777001), home, away, clonePlayers([...homeSquad, ...awaySquad]), {
    matchId: 700001,
    competitionId: 1,
    fixtureId: 700001,
    year: 1,
    homeNeutral: true,
  });
  const rng = createRng(777001);
  const players = clonePlayers([...homeSquad, ...awaySquad]);
  const { match } = simulateMatch(rng, home, away, players, {
    competitionId: 1,
    fixtureId: 700001,
    year: 1,
    homeNeutral: true,
  });
  const instantNeutral = digestInstant(match, players, {
    homeXI: lineupState.homeXI,
    awayXI: lineupState.awayXI,
    homeSubs: lineupState.homeSubs,
    awaySubs: lineupState.awaySubs,
  }, rng);

  // Keep the binding available to the final fixture object without relying on
  // block-scoped declarations in the capture script.
  instantNeutralDigest = instantNeutral;
}

// Instant tactical mismatch: PRESS vs COUNTER with lower-energy squads.
{
  const home = matchClub(1, tactics(1));
  const away = matchClub(2, tactics(2));
  const lineupState = createLiveMatchState(createRng(777002), home, away, clonePlayers([...homeSquad, ...awaySquad]), {
    matchId: 700002,
    competitionId: 1,
    fixtureId: 700002,
    year: 1,
    homeNeutral: false,
  });
  const rng = createRng(777002);
  const players = clonePlayers([...homeSquad, ...awaySquad]);
  for (const p of players) p.energy = 71;
  const { match } = simulateMatch(rng, home, away, players, {
    competitionId: 1,
    fixtureId: 700002,
    year: 1,
    homeNeutral: false,
  });
  const instantTactics = digestInstant(match, players, {
    homeXI: lineupState.homeXI,
    awayXI: lineupState.awayXI,
    homeSubs: lineupState.homeSubs,
    awaySubs: lineupState.awaySubs,
  }, rng);
  instantTacticsDigest = instantTactics;
}

// Live path with halftime break, a substitution and full-time state.
interface LiveDigest {
  homeXI: number[];
  awayXI: number[];
  homeSubs: number[];
  awaySubs: number[];
  homeOn: number[];
  awayOn: number[];
  scores: [number, number];
  ended: boolean;
  firstHalfAddedMinutes?: number;
  secondHalfAddedMinutes?: number;
  coinTossWinner?: 0 | 1;
  events: MatchEvent[];
  teamStats: { home: TeamMatchStats; away: TeamMatchStats };
  playerMinutes: Record<number, number>;
  playerEnergy: Record<number, number>;
  cards: unknown[];
  injuries: unknown[];
  substitutions: unknown[];
  rngState: number;
}
let liveFull: LiveDigest;
{
  const players = clonePlayers([...homeSquad, ...awaySquad]);
  const rng = createRng(777003);
  const st = createLiveMatchState(rng, homeClub, awayClub, players, {
    matchId: 700003,
    competitionId: 1,
    fixtureId: 700003,
    homeNeutral: true,
  });
  for (const chunk of [17, 23, 21]) tickLiveMatch(rng, homeClub, awayClub, players, st, chunk, { ignoreHalfTime: false });
  // Resume through halftime and keep going.
  for (const chunk of [31, 12]) tickLiveMatch(rng, homeClub, awayClub, players, st, chunk, { resume: true, ignoreHalfTime: false });
  if (!st.ended && st.awaySubs.length > 0 && st.homeOn.length > 10) {
    performLiveSub(rng, homeClub, awayClub, players, st, 0, st.homeOn[st.homeOn.length - 1], st.homeSubs[0]);
  }
  while (!st.ended) {
    const before = st.matchClockSeconds;
    tickLiveMatch(rng, homeClub, awayClub, players, st, 10, { resume: true });
    if (st.matchClockSeconds === before) break;
  }
  liveFull = {
    homeXI: st.homeXI,
    awayXI: st.awayXI,
    homeSubs: st.homeSubs,
    awaySubs: st.awaySubs,
    homeOn: st.homeOn,
    awayOn: st.awayOn,
    scores: [...st.scores] as [number, number],
    ended: st.ended,
    firstHalfAddedMinutes: st.firstHalfAddedMinutes,
    secondHalfAddedMinutes: st.secondHalfAddedMinutes,
    coinTossWinner: st.coinTossWinner,
    events: st.events,
    teamStats: st.teamStats,
    playerMinutes: st.playerMinutes,
    playerEnergy: st.playerEnergy,
    cards: st.cards,
    injuries: st.injuries,
    substitutions: st.substitutions,
    rngState: st.rngState.state,
  };
}

const fixture = {
  meta: {
    note: "Golden baseline captured from the pre-characteristic-removal generator (scripts/capture-generation-baseline.ts). Neutrality contract: fixed-seed output must be byte-identical after trait removal.",
    seedsPerCase: SEEDS_PER_CASE,
    skillOrder: SKILL_ORDER,
  },
  oracle,
  seniorPlayers,
  youthPlayers,
  matches: { instantNeutral: instantNeutralDigest, instantTactics: instantTacticsDigest, liveFull },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture));
process.stdout.write(`captured ${oracle.length} oracle cases, ${seniorPlayers.length} senior + ${youthPlayers.length} youth players -> ${OUT}\n`);
