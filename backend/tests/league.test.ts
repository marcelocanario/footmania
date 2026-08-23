import { describe, expect, it } from "vitest";
import { createLeagueFixtures, circleSchedule, validateDoubleRoundRobinFixtures } from "../src/game/league";
import { stableHash } from "../src/game/scheduling";
import type { Fixture } from "../src/game/types";

function ids(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** Opponent/venue sequence of one club across all rounds. */
function clubSequence(fixtures: Fixture[], clubId: number): { round: number; opp: number; venue: "H" | "A" }[] {
  return fixtures
    .filter((f) => f.homeClubId === clubId || f.awayClubId === clubId)
    .sort((a, b) => a.round - b.round)
    .map((f) => ({
      round: f.round,
      opp: f.homeClubId === clubId ? f.awayClubId : f.homeClubId,
      venue: f.homeClubId === clubId ? ("H" as const) : ("A" as const),
    }));
}

describe("tournament-style double round robin", () => {
  for (const size of [4, 6, 8]) {
    it(`builds a valid ${size}-club schedule with separated mirrored legs`, () => {
      const clubs = ids(size);
      const fixtures = createLeagueFixtures(stableHash(`test:${size}`), 1, clubs, 1, 2);
      expect(() => validateDoubleRoundRobinFixtures(fixtures, clubs, 2)).not.toThrow();
      expect(fixtures.length).toBe(size * (size - 1));

      const halfRounds = size - 1;
      for (const club of clubs) {
        const seq = clubSequence(fixtures, club);
        // No club ever faces the same opponent in consecutive rounds.
        for (let i = 1; i < seq.length; i++) {
          expect(seq[i].opp).not.toBe(seq[i - 1].opp);
        }
        // Every opponent is met once per half, and the return leg flips the venue.
        const byOpp = new Map<number, { round: number; venue: "H" | "A" }[]>();
        for (const step of seq) {
          const list = byOpp.get(step.opp) ?? [];
          list.push({ round: step.round, venue: step.venue });
          byOpp.set(step.opp, list);
        }
        expect(byOpp.size).toBe(size - 1);
        for (const legs of byOpp.values()) {
          expect(legs.length).toBe(2);
          expect(legs[0].round < halfRounds).toBe(true);
          expect(legs[1].round >= halfRounds).toBe(true);
          expect(legs[0].venue).not.toBe(legs[1].venue);
        }
        // Season home/away totals balance exactly.
        expect(seq.filter((s) => s.venue === "H").length).toBe(size - 1);
      }
    });
  }

  it("keeps venue breaks at the achievable minimum", () => {
    // Perfect alternation is impossible in a complete round robin; de Werra's
    // bound gives n-2 as the minimum venue breaks of a balanced single round
    // robin. The DP orientation reaches it for every seeded arrangement
    // (verified exhaustively for 4 clubs and across thousands of seeds).
    const bounds: Record<number, number> = { 4: 2, 6: 4, 8: 6 };
    for (const [sizeStr, bound] of Object.entries(bounds)) {
      const size = Number(sizeStr);
      const clubs = ids(size);
      const halfRounds = circleSchedule(stableHash(`breaks:${size}`), clubs).slice(0, size - 1);
      const venues = new Map<number, string[]>(clubs.map((c) => [c, []]));
      halfRounds.forEach((round) =>
        round.forEach(([h, a]) => {
          if (h === -1 || a === -1) return;
          venues.get(h)!.push("H");
          venues.get(a)!.push("A");
        })
      );
      let breaks = 0;
      for (const seq of venues.values()) {
        for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) breaks++;
      }
      expect(breaks).toBeLessThanOrEqual(bound);
    }
  });

  it("reproduces the same calendar from the same seed and varies across seeds", () => {
    const clubs = ids(8);
    const seed = stableHash("31:101");
    const first = createLeagueFixtures(seed, 101, clubs, 1, 2);
    const second = createLeagueFixtures(seed, 101, clubs, 1, 2);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Distinct season/division identities must be able to produce distinct orders.
    const variants = new Set<string>();
    for (let s = 0; s < 24; s++) {
      variants.add(JSON.stringify(createLeagueFixtures(stableHash(`season:${s}`), 1, clubs, 1, 2)));
    }
    expect(variants.size).toBeGreaterThan(1);
  });

  it("keeps structural guarantees on fields beyond the exact-orientation cutoff", () => {
    // Larger fields take the deterministic greedy orientation path; the
    // pairing structure (and therefore every invariant below) is identical —
    // only perfect break optimality is traded away.
    const size = 18;
    const clubs = ids(size);
    const fixtures = createLeagueFixtures(stableHash(`large:${size}`), 7, clubs, 1, 2);
    expect(() => validateDoubleRoundRobinFixtures(fixtures, clubs, 2)).not.toThrow();
    expect(fixtures.length).toBe(size * (size - 1));
    for (const club of clubs) {
      const seq = clubSequence(fixtures, club);
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i].opp).not.toBe(seq[i - 1].opp);
      }
      expect(seq.filter((s) => s.venue === "H").length).toBe(size - 1);
    }
    const again = createLeagueFixtures(stableHash(`large:${size}`), 7, clubs, 1, 2);
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(again));
  });
});
