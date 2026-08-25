import { describe, expect, it } from "vitest";
import { applyMatchToPlayers, createLiveMatchState, simulateMatch, tickLiveMatch } from "../src/game/match";
import { finalizeLiveMatch } from "../src/game/world";
import { buildSnapshot, liveMatchStatDeltas } from "../src/services/snapshot";
import { EVENT_CODES, GOAL_SUBTYPES } from "../src/game/constants";
import { createRng } from "../src/game/rng";
import type { Match, Player } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";
import { clonePlayers, goldenClub, goldenSquad, goldenTactics } from "./matchGolden";

/**
 * A goal scored during a live match must reflect on the player card immediately
 * (via the live-state GOAL events) and be committed durably at full time. The
 * possession engine never mutates the live Player rows directly — live ticks
 * persist only the match state, so an in-memory mutation would be lost on the
 * next reload. Attribution flows from the authoritative events instead:
 *  - while live: snapshot/player endpoints add the live deltas;
 *  - at full time: applyMatchToPlayers credits the Player rows once.
 */

/** One XI per side with enough roster for a bench. */
function squads(): Player[] {
  return clonePlayers([...goldenSquad(1, 1, 31111, 1000), ...goldenSquad(2, 4, 32222, 2000)]);
}

function goalEvent(playerId: number, player2Id: number | null, goalType = GOAL_SUBTYPES.NORMAL): Match["events"][number] {
  return { minute: 34, half: 1, type: EVENT_CODES.GOAL, subtype: goalType, clubId: 1, playerId, player2Id, goalType };
}

describe("live goal attribution", () => {
  it("credits goals and assists to players at full time from the match events", () => {
    const players = squads();
    const scorer = players[0];
    const assister = players[1];
    const other = players[2];
    const club = makeClub({ id: 1 });
    const world = makeWorld([club, makeClub({ id: 2 })], players);
    const match = {
      id: 1,
      events: [goalEvent(scorer.id, assister.id)],
      minutes: { [scorer.id]: 90, [assister.id]: 90, [other.id]: 0 },
    } as unknown as Match;

    applyMatchToPlayers(match, world);

    expect(scorer.seasonGoals).toBe(1);
    expect(scorer.careerGoals).toBe(1);
    expect(assister.seasonAssists).toBe(1);
    expect(assister.careerAssists).toBe(1);
    expect(other.seasonGoals).toBe(0);
    expect(other.seasonAssists).toBe(0);
  });

  it("never credits shootout penalty goals to season or career totals", () => {
    const players = squads();
    const taker = players[0];
    const world = makeWorld([makeClub({ id: 1 }), makeClub({ id: 2 })], players);
    const match = {
      id: 2,
      events: [goalEvent(taker.id, null, GOAL_SUBTYPES.PENALTY)],
      minutes: {},
    } as unknown as Match;

    applyMatchToPlayers(match, world);

    expect(taker.seasonGoals).toBe(0);
    expect(taker.careerGoals).toBe(0);
  });

  it("credits an instant simulation's goals to the real players (division history path)", () => {
    const players = squads();
    const rng = createRng(4242);
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const { match } = simulateMatch(rng, home, away, players, {
      competitionId: 1,
      fixtureId: 7,
      year: 1,
      homeNeutral: true,
    });
    const regulationGoals = match.events.filter((e) => e.type === EVENT_CODES.GOAL && e.goalType !== GOAL_SUBTYPES.PENALTY);
    const totalGoals = players.reduce((sum, p) => sum + p.seasonGoals, 0);
    const totalAssists = players.reduce((sum, p) => sum + p.seasonAssists, 0);
    const assisted = regulationGoals.filter((e) => e.player2Id !== null).length;

    expect(totalGoals).toBe(regulationGoals.length);
    expect(totalAssists).toBe(assisted);
    for (const goal of regulationGoals) {
      const scorer = players.find((p) => p.id === goal.playerId)!;
      expect(scorer.seasonGoals).toBeGreaterThan(0);
      expect(scorer.careerGoals).toBe(scorer.seasonGoals);
      if (goal.player2Id !== null) {
        const assister = players.find((p) => p.id === goal.player2Id)!;
        expect(assister.seasonAssists).toBeGreaterThan(0);
        expect(assister.careerAssists).toBe(assister.seasonAssists);
      }
    }
  });
});

describe("live match player-card visibility", () => {
  it("shows a goal scored mid-match on the snapshot card immediately", () => {
    const players = squads();
    const club = makeClub({ id: 1 });
    const world = makeWorld([club, makeClub({ id: 2 })], players, { humanClubId: 1 });
    const rng = createRng(777003);
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const st = createLiveMatchState(rng, home, away, players, {
      matchId: 700003,
      competitionId: 1,
      fixtureId: 700003,
      homeNeutral: true,
    });
    world.liveMatches.push(st);

    // Force a goal into the live events so the card reflects it before full time.
    const scorer = players.find((p) => p.clubId === 1)!;
    const assister = players.find((p) => p.clubId === 1 && p.id !== scorer.id)!;
    st.scores = [1, 0];
    st.events.push(goalEvent(scorer.id, assister.id));

    const snapshot = buildSnapshot(world, 1);
    const scorerCard = snapshot.squad.find((p) => p.id === scorer.id)!;
    const assisterCard = snapshot.squad.find((p) => p.id === assister.id)!;
    expect(scorerCard.seasonGoals).toBe(1);
    expect(scorerCard.careerGoals).toBe(1);
    expect(assisterCard.seasonAssists).toBe(1);
    expect(assisterCard.careerAssists).toBe(1);

    const deltas = liveMatchStatDeltas(world);
    expect(deltas.get(scorer.id)).toEqual({ goals: 1, assists: 0 });
    expect(deltas.get(assister.id)).toEqual({ goals: 0, assists: 1 });
  });

  it("resolves a streamed live match and commits goals once at full time", () => {
    const players = squads();
    const club = makeClub({ id: 1 });
    const world = makeWorld([club, makeClub({ id: 2 })], players, { humanClubId: 1 });
    const rng = createRng(777004);
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const st = createLiveMatchState(rng, home, away, players, {
      matchId: 700004,
      competitionId: 1,
      fixtureId: 700004,
      homeNeutral: true,
    });
    world.liveMatches.push(st);

    while (!st.ended) {
      const before = st.matchClockSeconds;
      tickLiveMatch(rng, home, away, players, st, 10, { resume: true });
      if (st.matchClockSeconds === before) break;
    }
    finalizeLiveMatch(world, st);

    const regulationGoals = st.events.filter((e) => e.type === EVENT_CODES.GOAL && e.goalType !== GOAL_SUBTYPES.PENALTY);
    const totalGoals = players.reduce((sum, p) => sum + p.seasonGoals, 0);
    const totalAssists = players.reduce((sum, p) => sum + p.seasonAssists, 0);
    expect(totalGoals).toBe(regulationGoals.length);
    expect(totalAssists).toBe(regulationGoals.filter((e) => e.player2Id !== null).length);
    expect(world.liveMatches).toHaveLength(0);
  });
});
