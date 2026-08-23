import { describe, expect, it } from "vitest";
import { generateWorld, createHumanClub } from "../src/game/worldgen";
import { createLiveMatchState } from "../src/game/match";
import { createRng } from "../src/game/rng";
import { EVENT_CODES } from "../src/game/constants";
import { liveStateDeltaView, liveStateView } from "../src/services/liveView";
import type { LiveMatchState } from "../src/game/types";

function setup() {
  const world = generateWorld(2026);
  const home = createHumanClub(world, { userId: 21, clubName: "Ball Home FC", country: "BRA", preferredHours: null });
  const away = createHumanClub(world, { userId: 22, clubName: "Ball Away FC", country: "GER", preferredHours: null });
  const st = createLiveMatchState(createRng(7), home, away, world.players, { matchId: 1, fixtureId: 1, competitionId: 1 });
  return { world, home, away, st };
}

describe("live view possession projection", () => {
  it("exposes the engine possession state in the full live view", () => {
    const { world, st } = setup();
    // Fresh state: coin-toss winner kicks off, neutral kickoff projection.
    const view = liveStateView(world, st);
    expect(view.ball).toEqual({
      side: st.withBall,
      zone: "DEF_CENTRAL",
      phase: "BUILD_UP",
      startType: "OPEN_PLAY",
      counter: false,
      carrierId: null,
      lastAction: null,
      prevZone: null,
      lastBallAction: null,
    });
  });

  it("mirrors engine possession changes into the delta view", () => {
    const { world, st } = setup();
    const advanced: LiveMatchState = {
      ...st,
      minute: 34,
      withBall: 1,
      zone: "BOX",
      phase: "FINAL_THIRD",
      possessionStartType: "CORNER",
      isCounter: true,
      ballCarrierId: st.awayOn[0],
      lastBallAction: {
        sequence: 4,
        action: "CROSS",
        outcome: "CONTINUE",
        side: 0,
        fromZone: "ATT_WIDE",
        toZone: "BOX",
        fromPlayerId: st.homeOn[0],
        targetPlayerId: st.homeOn[1],
        interceptorId: null,
        foulerId: null,
      },
      lastAction: "CROSS",
      prevZone: "ATT_WIDE",
      events: [{ minute: 34, half: 1, type: EVENT_CODES.GOAL, subtype: 1, clubId: st.homeClubId, playerId: null, player2Id: null, goalType: 1 }],
    };
    const delta = liveStateDeltaView(world, advanced, 0);
    expect(delta.ball).toEqual({
      side: 1,
      zone: "BOX",
      phase: "FINAL_THIRD",
      startType: "CORNER",
      counter: true,
      carrierId: st.awayOn[0],
      lastAction: "CROSS",
      prevZone: "ATT_WIDE",
      lastBallAction: advanced.lastBallAction,
    });
    expect(delta.minute).toBe(34);
    expect(delta.newEvents).toHaveLength(1);
  });

  it("falls back to a kickoff projection for states persisted before the engine runtime existed", () => {
    const { world, st } = setup();
    const legacy = st as unknown as Record<string, unknown>;
    delete legacy.zone;
    delete legacy.phase;
    delete legacy.possessionStartType;
    delete legacy.isCounter;
    delete legacy.withBall;
    delete legacy.lastAction;
    delete legacy.prevZone;
    const view = liveStateView(world, legacy as unknown as LiveMatchState);
    expect(view.ball).toEqual({
      side: 0,
      zone: "DEF_CENTRAL",
      phase: "BUILD_UP",
      startType: "KICK_OFF",
      counter: false,
      carrierId: null,
      lastAction: null,
      prevZone: null,
      lastBallAction: null,
    });
  });
});
