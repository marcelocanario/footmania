import { describe, expect, it } from "vitest";
import baseline from "./fixtures/match-golden.json";
import {
  clonePlayers,
  goldenClub,
  goldenSquad,
  goldenTactics,
  instantDigest,
  liveDigest,
  type InstantDigest,
  type LiveDigest,
} from "./matchGolden";
import { createLiveMatchState, tickLiveMatch } from "../src/game/match";
import { createRng } from "../src/game/rng";
import type { LiveMatchState } from "../src/game/types";

/**
 * Fixed-seed regression lock for the match engine (plan 6 neutrality, plan 9
 * Phase 11.9). The committed golden digests pin scores, events, stats, fatigue,
 * workload bookkeeping and the final RNG state of three matches; regenerate
 * via `npm run regenerate:match-golden` ONLY after an intentional sim change.
 */
const fixture = baseline as unknown as {
  instantNeutral: InstantDigest;
  instantTactics: InstantDigest;
  liveFull: LiveDigest;
};

describe("match neutrality", () => {
  it("replays fixed-seed instant matches exactly against the golden digests", () => {
    const homeSquad = goldenSquad(1, 1, 31111, 1000);
    const awaySquad = goldenSquad(2, 4, 32222, 2000);

    const neutralPlayers = clonePlayers([...homeSquad, ...awaySquad]);
    expect(instantDigest(777001, 700001, goldenClub(1, goldenTactics(0)), goldenClub(2, goldenTactics(0)), neutralPlayers, true))
      .toEqual(fixture.instantNeutral);

    const tacticalPlayers = clonePlayers([...homeSquad, ...awaySquad]);
    for (const player of tacticalPlayers) player.energy = 71;
    expect(instantDigest(777002, 700002, goldenClub(1, goldenTactics(1)), goldenClub(2, goldenTactics(2)), tacticalPlayers, false, [...homeSquad, ...awaySquad]))
      .toEqual(fixture.instantTactics);
  });

  it("is replay-stable within a build (identical inputs produce identical digests)", () => {
    const squads = [...goldenSquad(1, 1, 31111, 1000), ...goldenSquad(2, 4, 32222, 2000)];
    const a = instantDigest(777001, 700001, goldenClub(1, goldenTactics(0)), goldenClub(2, goldenTactics(0)), clonePlayers(squads), true);
    const b = instantDigest(777001, 700001, goldenClub(1, goldenTactics(0)), goldenClub(2, goldenTactics(0)), clonePlayers(squads), true);
    expect(a).toEqual(b);
  });

  it("replays the fixed-seed live match against the golden digest and is self-stable", () => {
    const players = clonePlayers([
      ...goldenSquad(1, 1, 31111, 1000),
      ...goldenSquad(2, 4, 32222, 2000),
    ]);
    const digest = liveDigest(goldenClub(1, goldenTactics(0)), goldenClub(2, goldenTactics(2)), players);
    expect(digest).toEqual(fixture.liveFull);

    const replayed = liveDigest(goldenClub(1, goldenTactics(0)), goldenClub(2, goldenTactics(2)), clonePlayers([
      ...goldenSquad(1, 1, 31111, 1000),
      ...goldenSquad(2, 4, 32222, 2000),
    ]));
    expect(replayed).toEqual(digest);
  });

  it("ignores persisted presentation metadata when resuming simulation", () => {
    const run = (injectMetadata: boolean): LiveMatchState => {
      const home = goldenClub(1, goldenTactics(0));
      const away = goldenClub(2, goldenTactics(2));
      const players = clonePlayers([
        ...goldenSquad(1, 1, 31111, 1000),
        ...goldenSquad(2, 4, 32222, 2000),
      ]);
      const rng = createRng(777004);
      const state = createLiveMatchState(rng, home, away, players, {
        matchId: 700004,
        competitionId: 1,
        fixtureId: 700004,
        homeNeutral: true,
      });
      // Remove wall-clock noise from the state comparison; it is not part of
      // the simulation and is normally assigned by the live worker boundary.
      state.lastAdvancedAt = 0;
      tickLiveMatch(rng, home, away, players, state, 20, { ignoreHalfTime: true });
      if (injectMetadata) {
        const currentSide = state.withBall === 0 ? state.homeOn : state.awayOn;
        const alternateCarrier = currentSide.find((id) => id !== state.ballCarrierId) ?? currentSide[0] ?? null;
        state.ballCarrierId = alternateCarrier;
        state.ballActionSequence = 987654;
        state.lastAction = "SHOT";
        state.prevZone = "BOX";
        state.lastBallAction = {
          sequence: 987654,
          action: "SHOT",
          outcome: "PENDING",
          side: (state.withBall === 1 ? 1 : 0) as 0 | 1,
          fromZone: "BOX",
          toZone: "BOX",
          fromPlayerId: alternateCarrier,
          targetPlayerId: null,
          interceptorId: null,
          foulerId: null,
        };
      }
      tickLiveMatch(rng, home, away, players, state, 20, { ignoreHalfTime: true });
      tickLiveMatch(rng, home, away, players, state, 20, { ignoreHalfTime: true });
      return state;
    };

    const stripPresentation = (state: LiveMatchState) => {
      const {
        lastAction: _lastAction,
        prevZone: _prevZone,
        ballCarrierId: _ballCarrierId,
        ballActionSequence: _ballActionSequence,
        lastBallAction: _lastBallAction,
        ...authoritative
      } = state;
      return authoritative;
    };

    expect(stripPresentation(run(false))).toEqual(stripPresentation(run(true)));
  });
});
