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
});
