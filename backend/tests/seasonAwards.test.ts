import { describe, expect, it } from "vitest";
import { computeSeasonAwards } from "../src/game/season";
import { applyMatchToPlayers, simulateMatch } from "../src/game/match";
import { EVENT_CODES, GOAL_SUBTYPES } from "../src/game/constants";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Competition, Match, Player } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";
import { clonePlayers, goldenClub, goldenSquad, goldenTactics } from "./matchGolden";

/**
 * Season-award unit coverage: per-division top scorer/assists/POTY/Best XI,
 * the configured minimum-appearance eligibility rule, structured Best XI
 * detail entries and the engine's neutral assist bookkeeping.
 */

let nextDivisionId = 910_000;

function division(clubIds: number[], seasonId = 1): Competition {
  return {
    id: nextDivisionId++,
    kind: "division",
    name: `1.${clubIds[0]}`,
    round: 0,
    stage: "group",
    seasonId,
    tier: 1,
    groupIndex: 0,
    status: "ACTIVE",
    config: { clubs: [...clubIds], turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
    standings: {},
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
}

function squad(clubId: number, rngSeed: number): Player[] {
  // One keeper plus outfield slots so a full Best XI can be picked.
  const positions = [0, 1, 1, 2, 2, 3, 3, 4, 4] as const;
  const rng = createRng(rngSeed);
  return positions.map((position, slot) => generatePlayer(rng, makeClub({ id: clubId }), { id: clubId * 100 + slot + 1, position }));
}

/** With two clubs (turns=2) a club plays 2 league games; 0.4 → ceil(0.8)=1 required appearance. */
function worldWith(divisions: Competition[], clubs: Club[], players: Player[]) {
  return makeWorld(clubs, players, { competitions: divisions, fixtures: [] });
}

describe("computeSeasonAwards", () => {
  it("awards top scorer, top assists and POTY per division with assists tracked", () => {
    const [a, b] = [makeClub({ id: 1 }), makeClub({ id: 2 })];
    const players = [...squad(1, 11), ...squad(2, 22)];
    for (const p of players) p.seasonAppearances = 5;
    const strikerA = players.find((p) => p.clubId === 1 && p.position === 4)!;
    strikerA.seasonGoals = 7;
    const playmakerB = players.find((p) => p.clubId === 2 && p.position === 3)!;
    playmakerB.seasonAssists = 4;
    const world = worldWith([division([a.id, b.id])], [a, b], players);

    computeSeasonAwards(world);

    const byCategory = (category: string) => world.seasonAwards.filter((award) => award.category === category);
    expect(byCategory("top_scorer")).toHaveLength(1);
    expect(byCategory("top_scorer")[0].playerId).toBe(strikerA.id);
    expect(byCategory("top_scorer")[0].detail).toContain("7 goals");

    expect(byCategory("top_assists")).toHaveLength(1);
    expect(byCategory("top_assists")[0].playerId).toBe(playmakerB.id);
    expect(byCategory("top_assists")[0].detail).toContain("4 assists");

    expect(byCategory("player_of_season")).toHaveLength(1);
    expect(world.seasonAwards.every((award) => award.season === world.mp.seasonYear)).toBe(true);
  });

  it("produces one award set per division+group, never aggregated", () => {
    const clubs = [makeClub({ id: 1, name: "A" }), makeClub({ id: 2, name: "B" }), makeClub({ id: 3, name: "C" }), makeClub({ id: 4, name: "D" })];
    const players = [...squad(1, 31), ...squad(2, 32), ...squad(3, 33), ...squad(4, 34)];
    for (const p of players) p.seasonAppearances = 5;
    players.find((p) => p.clubId === 1 && p.position === 4)!.seasonGoals = 9;
    players.find((p) => p.clubId === 3 && p.position === 4)!.seasonGoals = 5;
    const divOne = division([1, 2]);
    const divTwo = division([3, 4]);
    const world = worldWith([divOne, divTwo], clubs, players);

    computeSeasonAwards(world);

    const scorers = world.seasonAwards.filter((award) => award.category === "top_scorer");
    expect(scorers).toHaveLength(2);
    expect(scorers.map((award) => award.competitionId).sort()).toEqual([divOne.id, divTwo.id].sort());
    expect(scorers.map((award) => award.playerId)).toEqual(expect.arrayContaining([
      players.find((p) => p.clubId === 1 && p.position === 4)!.id,
      players.find((p) => p.clubId === 3 && p.position === 4)!.id,
    ]));
  });

  it("excludes players below the configured appearance threshold from every award", () => {
    const clubs = [makeClub({ id: 1 }), makeClub({ id: 2 })];
    const players = [...squad(1, 41), ...squad(2, 42)];
    // Two-game season → one required appearance. The bench-warmer played none
    // yet dominates on raw talent and production.
    for (const p of players) p.seasonAppearances = 5;
    const benchWarmer = players.find((p) => p.clubId === 1 && p.position === 3)!;
    benchWarmer.overall = 99;
    benchWarmer.seasonAppearances = 0;
    benchWarmer.seasonGoals = 20;
    benchWarmer.seasonAssists = 20;
    const starter = players.find((p) => p.clubId === 2 && p.position === 4)!;
    starter.overall = 50;
    starter.seasonGoals = 40;
    const world = worldWith([division([1, 2])], clubs, players);

    computeSeasonAwards(world);

    const xiAward = world.seasonAwards.find((award) => award.category === "best_xi");
    const xiEntries = xiAward ? (JSON.parse(xiAward.detail!) as { id: number }[]) : [];
    expect(xiEntries.some((entry) => entry.id === benchWarmer.id)).toBe(false);
    expect(world.seasonAwards.some((award) => award.category === "player_of_season" && award.playerId === benchWarmer.id)).toBe(false);
    expect(world.seasonAwards.some((award) => award.category === "player_of_season" && award.playerId === starter.id)).toBe(true);
    expect(world.seasonAwards.some((award) => award.category === "top_scorer" && award.playerId === benchWarmer.id)).toBe(false);
    expect(world.seasonAwards.some((award) => award.category === "top_scorer" && award.playerId === starter.id)).toBe(true);
  });

  it("stores Best XI members as structured id/name/club entries", () => {
    const clubs = [makeClub({ id: 1 }), makeClub({ id: 2 })];
    const players = [...squad(1, 51), ...squad(2, 52)];
    for (const p of players) {
      p.seasonAppearances = 5;
      p.overall += p.id % 7; // deterministic spread of ratings
    }
    const world = worldWith([division([1, 2])], clubs, players);

    computeSeasonAwards(world);

    const xiAward = world.seasonAwards.find((award) => award.category === "best_xi")!;
    expect(xiAward).toBeDefined();
    const entries = JSON.parse(xiAward.detail!) as { id: number; clubId: number | null; name: string }[];
    expect(entries).toHaveLength(11);
    for (const entry of entries) {
      const player = players.find((p) => p.id === entry.id)!;
      expect(entry.name).toBe(player.name);
      expect(entry.clubId).toBe(player.clubId);
    }
  });

  it("skips awards entirely when nobody meets the appearance floor", () => {
    const clubs = [makeClub({ id: 1 }), makeClub({ id: 2 })];
    const players = [...squad(1, 61), ...squad(2, 62)];
    for (const p of players) {
      p.seasonAppearances = 0;
      p.seasonGoals = 4;
      p.seasonAssists = 3;
    }
    const world = worldWith([division([1, 2])], clubs, players);

    computeSeasonAwards(world);

    expect(world.seasonAwards).toHaveLength(0);
  });
});

describe("appearance bookkeeping", () => {
  it("counts exactly one appearance per match with pitch time", () => {
    const club = makeClub({ id: 1 });
    const other = makeClub({ id: 2 });
    const players = squad(1, 71);
    const world = makeWorld([club, other], players);

    const match = {
      events: [],
      minutes: Object.fromEntries(players.map((p) => [p.id, p.id % 2 === 0 ? 90 : 25])),
    } as unknown as Match;

    applyMatchToPlayers(match, world);

    for (const p of players) expect(p.seasonAppearances ?? 0).toBe(1);
  });

  it("does not count an appearance without any pitch time", () => {
    const club = makeClub({ id: 1 });
    const other = makeClub({ id: 2 });
    const players = squad(1, 72);
    const unusedSub = players[8];
    const world = makeWorld([club, other], players);

    const match = {
      events: [],
      minutes: Object.fromEntries(players.map((p) => [p.id, p.id === unusedSub.id ? 0 : 90])),
    } as unknown as Match;

    applyMatchToPlayers(match, world);

    expect(unusedSub.seasonAppearances ?? 0).toBe(0);
    expect(players[0].seasonAppearances ?? 0).toBe(1);
  });
});

describe("engine assist attribution", () => {
  const run = (seed: number) => {
    const players = clonePlayers([...goldenSquad(1, 1, 31111, 1000), ...goldenSquad(2, 4, 32222, 2000)]);
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const rng = createRng(seed);
    const { match } = simulateMatch(rng, home, away, players, { competitionId: 1, fixtureId: seed, year: 1, homeNeutral: true });
    return { match, players };
  };

  it("credits each open-play assist exactly once, only to a same-side teammate", () => {
    const { match, players } = run(4242);
    const homeIds = new Set(players.filter((p) => p.clubId === 1).map((p) => p.id));
    const awayIds = new Set(players.filter((p) => p.clubId === 2).map((p) => p.id));

    // Regulation goals only: shootout penalties carry goalType PENALTY.
    const goals = match.events.filter((e) => e.type === EVENT_CODES.GOAL && e.goalType !== GOAL_SUBTYPES.PENALTY);
    const assisted = goals.filter((e) => e.player2Id !== null);
    const totalAssists = players.reduce((sum, p) => sum + p.seasonAssists, 0);
    const totalCareerAssists = players.reduce((sum, p) => sum + p.careerAssists, 0);

    expect(match.homeScore + match.awayScore).toBe(goals.length);
    expect(totalAssists).toBe(assisted.length);
    expect(totalCareerAssists).toBe(totalAssists);
    for (const goal of assisted) {
      expect(goal.player2Id).not.toBe(goal.playerId);
      const side = homeIds.has(goal.playerId!) ? homeIds : awayIds;
      expect(side.has(goal.player2Id!)).toBe(true);
      const assister = players.find((p) => p.id === goal.player2Id)!;
      expect(assister.seasonAssists).toBeGreaterThan(0);
    }
  });

  it("is deterministic: identical seeds produce identical assist attribution", () => {
    const first = run(4242);
    const second = run(4242);
    const assistsOf = (result: ReturnType<typeof run>) =>
      result.match.events.filter((e) => e.type === EVENT_CODES.GOAL).map((e) => `${e.minute}:${e.playerId}:${e.player2Id}`);
    expect(assistsOf(second)).toEqual(assistsOf(first));
  });

  it("never records shootout penalties with an assist", () => {
    const { match } = run(777);
    const shootoutGoals = match.events.filter((e) => e.type === EVENT_CODES.GOAL && e.goalType === GOAL_SUBTYPES.PENALTY);
    expect(shootoutGoals.every((e) => e.player2Id === null)).toBe(true);
  });
});
