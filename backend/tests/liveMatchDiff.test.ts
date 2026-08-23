import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createLiveMatchState } from "../src/game/match";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { EVENT_CODES, GOAL_SUBTYPES } from "../src/game/constants";
import type { Club, LiveMatchState, Match, MatchEvent, Player } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";
import { diffLiveMatchAdvances, snapshotLiveMatches } from "../src/services/liveMatchDiff";
import { notifyMatchFinished, notifyMatchGoal } from "../src/services/notifications";

let nextPlayerId = 1;
function squad(club: Club, rng: ReturnType<typeof createRng>, size = 16): Player[] {
  const players: Player[] = [];
  for (let i = 0; i < size; i++) {
    players.push(generatePlayer(rng, club, { id: nextPlayerId++, isYouth: false }));
  }
  return players;
}

function makeLiveState(rng: ReturnType<typeof createRng>, home: Club, away: Club, players: Player[], matchId: number): LiveMatchState {
  const st = createLiveMatchState(rng, home, away, players, { matchId, competitionId: 1, fixtureId: matchId });
  st.lastAdvancedAt = 1000;
  return st;
}

function goalEvent(minute: number, clubId: number): MatchEvent {
  return { minute, half: 2, type: EVENT_CODES.GOAL, subtype: GOAL_SUBTYPES.NORMAL, clubId, playerId: null, player2Id: null, goalType: GOAL_SUBTYPES.NORMAL };
}

describe("diffLiveMatchAdvances", () => {
  it("collects goals scored in the tick that finishes a match (state detached by finalize)", () => {
    const rng = createRng(11);
    const home = makeClub({ id: 1 });
    const away = makeClub({ id: 2 });
    const players = [...squad(home, rng), ...squad(away, rng)];
    const st = makeLiveState(rng, home, away, players, 501);

    const before = snapshotLiveMatches([st]);

    // Simulate the finishing advance: final-tick events land on the same
    // object, then finalizeLiveMatch detaches it from world.liveMatches.
    st.events.push(goalEvent(92, home.id));
    st.scores = [1, 0];
    const finished: Match[] = [{
      id: 501,
      fixtureId: 501,
      competitionId: 1,
      homeClubId: home.id,
      awayClubId: away.id,
      homeScore: 1,
      awayScore: 0,
      penaltyWinnerId: null,
      events: [...st.events],
      stats: st.stats,
      minuteEvents: [],
    }];

    const { updates, changedStates, goals } = diffLiveMatchAdvances(before, [], finished);
    expect(changedStates).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ matchId: 501, finished: true, phaseChanged: true, eventStart: 1 });
    // Regression guard: the stoppage-time goal must still be reported.
    expect(goals).toEqual([{ matchId: 501, clubId: home.id, minute: 92 }]);
  });

  it("reports running-match changes and their new events", () => {
    const rng = createRng(12);
    const home = makeClub({ id: 1 });
    const away = makeClub({ id: 2 });
    const players = [...squad(home, rng), ...squad(away, rng)];
    const st = makeLiveState(rng, home, away, players, 502);
    const before = snapshotLiveMatches([st]);

    st.minute = 10;
    st.scores = [0, 1];
    st.lastAdvancedAt = 2000;
    st.events.push(goalEvent(10, away.id));

    const { updates, changedStates, goals } = diffLiveMatchAdvances(before, [st], []);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ matchId: 502, eventStart: 1, phaseChanged: false, finished: false });
    expect(changedStates).toEqual([st]);
    expect(goals).toEqual([{ matchId: 502, clubId: away.id, minute: 10 }]);
  });

  it("reports nothing when a match did not advance", () => {
    const rng = createRng(13);
    const home = makeClub({ id: 1 });
    const away = makeClub({ id: 2 });
    const players = [...squad(home, rng), ...squad(away, rng)];
    const st = makeLiveState(rng, home, away, players, 503);
    const before = snapshotLiveMatches([st]);

    const { updates, changedStates, goals } = diffLiveMatchAdvances(before, [st], []);
    expect(updates).toHaveLength(0);
    expect(changedStates).toHaveLength(0);
    expect(goals).toHaveLength(0);
  });
});

describe("notifyMatchGoal", () => {
  function stubPrisma(proUserIds: Set<number>, created: { userId: number; type: string; payload: unknown }[]): PrismaClient {
    const dedupeKeys = new Set<string>();
    return {
      user: {
        findUnique: async ({ where }: { where: { id: number } }) => (proUserIds.has(where.id) ? { id: where.id, isPro: true } : null),
      },
      userNotification: {
        create: async ({ data }: { data: { userId: number; type: string; payloadJson: string; dedupeKey?: string | null } }) => {
          if (data.dedupeKey && dedupeKeys.has(`${data.userId}:${data.dedupeKey}`)) {
            throw new Error("Unique constraint failed");
          }
          if (data.dedupeKey) dedupeKeys.add(`${data.userId}:${data.dedupeKey}`);
          created.push({ userId: data.userId, type: data.type, payload: JSON.parse(data.payloadJson) });
          return data;
        },
      },
    } as unknown as PrismaClient;
  }

  function worldWithFinishedMatch(homeOwner: number | null, awayOwner: number | null) {
    const home = makeClub({ id: 1, ownerUserId: homeOwner });
    const away = makeClub({ id: 2, ownerUserId: awayOwner });
    const world = makeWorld([home, away], []);
    world.matches.push({
      id: 504,
      fixtureId: 404,
      competitionId: 1,
      homeClubId: home.id,
      awayClubId: away.id,
      homeScore: 2,
      awayScore: 1,
      penaltyWinnerId: null,
      events: [goalEvent(90, home.id)],
      stats: { home: emptyTeamStats(), away: emptyTeamStats() },
      minuteEvents: [],
    });
    return { world, home };
  }

  function emptyTeamStats() {
    return {
      controlledBallSeconds: 0, attackingThirdControlledSeconds: 0, possessions: 0, passes: 0, crosses: 0,
      carries: 0, dribbles: 0, turnovers: 0, highRecoveries: 0, counterattacks: 0, counterattackShots: 0,
      boxEntries: 0, shots: 0, shotsOnTarget: 0, xG: 0, corners: 0, fouls: 0, yellows: 0, reds: 0, offsides: 0, penalties: 0, injuries: 0,
    };
  }

  it("falls back to the persisted Match record when the live state is already detached", async () => {
    const created: { userId: number; type: string; payload: unknown }[] = [];
    const prisma = stubPrisma(new Set([7]), created);
    const { world, home } = worldWithFinishedMatch(7, null);

    await notifyMatchGoal(prisma, world, 504, home.id, 90);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userId: 7, type: "MATCH_GOAL" });
    expect(created[0].payload).toMatchObject({ matchId: 504, fixtureId: 404, scoringClubId: home.id, minute: 90, scores: [2, 1] });
  });

  it("skips users without pro", async () => {
    const created: { userId: number; type: string; payload: unknown }[] = [];
    const prisma = stubPrisma(new Set(), created);
    const { world } = worldWithFinishedMatch(7, 8);

    await notifyMatchGoal(prisma, world, 504, 1, 90);

    expect(created).toHaveLength(0);
  });

  it("does not recreate the same goal notification when a finishing retry replays it", async () => {
    const created: { userId: number; type: string; payload: unknown }[] = [];
    const prisma = stubPrisma(new Set([7]), created);
    const { world, home } = worldWithFinishedMatch(7, null);

    await notifyMatchGoal(prisma, world, 504, home.id, 90);
    await notifyMatchGoal(prisma, world, 504, home.id, 90);

    expect(created).toHaveLength(1);
  });

  it("does not recreate the same full-time notification on a scheduler retry", async () => {
    const created: { userId: number; type: string; payload: unknown }[] = [];
    const prisma = stubPrisma(new Set(), created);
    const { world } = worldWithFinishedMatch(7, null);
    const match = world.matches[0];
    if (!match) throw new Error("test match was not created");

    await notifyMatchFinished(prisma, world, match);
    await notifyMatchFinished(prisma, world, match);

    expect(created).toHaveLength(1);
  });
});
