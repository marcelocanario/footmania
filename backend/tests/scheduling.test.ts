import { describe, expect, it } from "vitest";
import { makeClub, makeWorld } from "./helpers";
import type { Competition, World } from "../src/game/types";
import { emptyStandingsRow } from "../src/game/league";
import { generateDivisionFixtures } from "../src/game/multiplayer";
import { roundDayIndex } from "../src/services/seasonCalendar";
import {
  pickFixtureKickoff,
  pickSynchronizedKickoff,
  preferenceDistance,
  utcSlotAt,
  validatePreferredHours,
} from "../src/game/scheduling";

const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_MS = 30 * 60 * 1000;
const SEASON_START = Date.UTC(2026, 0, 1);

function slots(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function utcAt(dayStart: number, slot: number): number {
  return dayStart + slot * SLOT_MS;
}

describe("preferred-time distance", () => {
  it("maps UTC instants to UTC half-hour slots", () => {
    // The server grid is pure UTC: 19:00Z is slot 38, 19:30Z slot 39.
    const instant = Date.UTC(2026, 0, 15, 19, 0);
    expect(utcSlotAt(instant)).toBe(38);
    expect(utcSlotAt(instant + 30 * 60 * 1000)).toBe(39);
    expect(utcSlotAt(Date.UTC(2026, 0, 15, 0, 0))).toBe(0);
  });

  it("measures circular distance to the nearest preferred slot", () => {
    const prefs = [...slots(46, 47), ...slots(0, 1)]; // 23:00–01:30
    const day = Date.UTC(2026, 0, 2);
    expect(preferenceDistance(prefs, utcAt(day, 46))).toBe(0);
    expect(preferenceDistance(prefs, utcAt(day, 0))).toBe(0);
    // 03:00 is five half-hours past the 01:00 window edge.
    expect(preferenceDistance(prefs, utcAt(day, 6))).toBe(5);
    // Midnight wraps: 23:00 is one slot from the 23:30 window.
    expect(preferenceDistance([0], utcAt(day, 47))).toBe(1);
  });

  it("treats missing preferences as unconstrained", () => {
    const day = Date.UTC(2026, 0, 2);
    expect(preferenceDistance(null, utcAt(day, 13))).toBe(0);
    expect(preferenceDistance([], utcAt(day, 13))).toBe(0);
  });
});

describe("fixture kickoff selection", () => {
  const day = Date.UTC(2026, 0, 2);

  it("picks an overlapping slot when preferences intersect", () => {
    // Home 15:00–21:00, away 18:00–24:00 → the selected slot is in their overlap.
    const kickoff = pickFixtureKickoff({ preferredSlots: slots(30, 41) }, { preferredSlots: slots(36, 47) }, day, "overlap");
    expect(slots(36, 41).map((slot) => utcAt(day, slot))).toContain(kickoff);
    expect(kickoff).toBe(pickFixtureKickoff({ preferredSlots: slots(30, 41) }, { preferredSlots: slots(36, 47) }, day, "overlap"));
  });

  it("falls back to the home-best slot closest to the away windows", () => {
    // Home 01:00–09:00, away 14:00–22:00: no overlap. Midnight wrapping makes
    // 01:00 the home slot closest to the away block's late end (22:30).
    const kickoff = pickFixtureKickoff({ preferredSlots: slots(2, 17) }, { preferredSlots: slots(28, 43) }, day, "disjoint");
    expect(kickoff).toBe(utcAt(day, 2));
  });

  it("lets an unconstrained opponent defer to the home club and seeded spread", () => {
    // Home 10:00–14:00, away AI (unconstrained): any home slot wins on
    // distance, then the stable seed selects one of those equally good slots.
    const kickoff = pickFixtureKickoff({ preferredSlots: slots(20, 27) }, { preferredSlots: null }, day, "home-window");
    expect(slots(20, 27).map((slot) => utcAt(day, slot))).toContain(kickoff);
    expect(kickoff).toBe(pickFixtureKickoff({ preferredSlots: slots(20, 27) }, { preferredSlots: null }, day, "home-window"));
  });

  it("synchronizes a final round on one shared instant", () => {
    const pairs = [
      { home: { preferredSlots: slots(24, 29) }, away: { preferredSlots: slots(26, 31) } },
      { home: { preferredSlots: slots(36, 41) }, away: { preferredSlots: null } },
      { home: { preferredSlots: slots(12, 17) }, away: { preferredSlots: slots(14, 19) } },
      { home: { preferredSlots: slots(40, 45) }, away: { preferredSlots: slots(42, 47) } },
    ];
    const kickoff = pickSynchronizedKickoff(pairs, day, "final-round");
    // Brute force: no candidate beats the chosen one on (homeSum, awaySum).
    let best: { home: number; away: number } | null = null;
    for (let slot = 0; slot < 48; slot++) {
      const at = utcAt(day, slot);
      const home = pairs.reduce((sum, p) => sum + preferenceDistance(p.home.preferredSlots, at), 0);
      const away = pairs.reduce((sum, p) => sum + preferenceDistance(p.away.preferredSlots, at), 0);
      if (best === null || home < best.home || (home === best.home && away < best.away)) best = { home, away };
    }
    const chosenHome = pairs.reduce((sum, p) => sum + preferenceDistance(p.home.preferredSlots, kickoff), 0);
    const chosenAway = pairs.reduce((sum, p) => sum + preferenceDistance(p.away.preferredSlots, kickoff), 0);
    expect(chosenHome).toBe(best!.home);
    expect(chosenAway).toBe(best!.away);
    // Deterministic regardless of input order.
    expect(kickoff).toBe(pickSynchronizedKickoff([...pairs].reverse(), day, "final-round"));
  });

  it("spreads unconstrained fixtures across the day deterministically", () => {
    const unconstrained = { preferredSlots: null };
    const kickoffs = Array.from({ length: 24 }, (_, i) => pickFixtureKickoff(unconstrained, unconstrained, day, `division:0:${i}:home:away`));
    const slotsChosen = new Set(kickoffs.map((kickoff) => Math.round((kickoff - day) / SLOT_MS)));

    expect(slotsChosen.size).toBeGreaterThan(8);
    expect(kickoffs).toEqual(Array.from({ length: 24 }, (_, i) => pickFixtureKickoff(unconstrained, unconstrained, day, `division:0:${i}:home:away`)));
  });
});

function testWorld(clubPrefs: (number[] | null)[]): { world: World; comp: Competition } {
  const clubs = clubPrefs.map((prefs, i) =>
    makeClub({
      id: 100 + i,
      name: `Club ${i}`,
      ownerUserId: prefs === null ? null : 10 + i,
      isHuman: prefs !== null,
      preferredHours: prefs,
    })
  );
  const world = makeWorld(clubs, []);
  world.mp.seasonStartAt = SEASON_START;
  const clubIds = clubs.map((c) => c.id);
  const comp: Competition = {
    id: 501,
    kind: "division",
    name: "T",
    round: 0,
    stage: "group",
    config: { clubs: clubIds, turns: 2, groups: [], bracket: [], promoted: 0, relegated: 0, groupQualifiers: 0 },
    standings: Object.fromEntries(clubIds.map((id) => [id, emptyStandingsRow(id)])),
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
  return { world, comp };
}

describe("generateDivisionFixtures timing", () => {
  it("times ordinary rounds per fixture and synchronizes the final round", () => {
    const prefs = [slots(24, 35), slots(30, 41), slots(36, 47), slots(0, 11), slots(6, 17), slots(12, 23), slots(18, 29), null];
    const { world, comp } = testWorld(prefs);
    const fixtures = generateDivisionFixtures(world, comp, { year: 2026, month: 1 });
    expect(fixtures.length).toBe(56);

    const lastRound = Math.max(...fixtures.map((f) => f.round));
    const prefOf = (clubId: number) => ({ preferredSlots: world.clubs.find((c) => c.id === clubId)!.preferredHours ?? null });

    for (const f of fixtures) {
      expect(f.kickoffAt).toBeDefined();
      expect(f.scheduledSeasonDayIndex).toBe(roundDayIndex(f.round));
      const dayStart = SEASON_START + roundDayIndex(f.round) * DAY_MS;
      if (f.round === lastRound) continue;
      // Ordinary rounds follow the per-fixture objective exactly.
      expect(f.kickoffAt).toBe(pickFixtureKickoff(prefOf(f.homeClubId), prefOf(f.awayClubId), dayStart, `${comp.id}:${f.round}:${f.homeClubId}:${f.awayClubId}`));
    }

    const finals = fixtures.filter((f) => f.round === lastRound);
    expect(finals.length).toBe(4);
    expect(new Set(finals.map((f) => f.kickoffAt)).size).toBe(1);
    const dayStart = SEASON_START + roundDayIndex(lastRound) * DAY_MS;
    expect(finals[0].kickoffAt).toBe(
      pickSynchronizedKickoff(finals.map((f) => ({ home: prefOf(f.homeClubId), away: prefOf(f.awayClubId) })), dayStart, `${comp.id}:${lastRound}`)
    );
  });

  it("keeps game days fixed regardless of preferences", () => {
    const { world, comp } = testWorld([slots(0, 7), slots(40, 47), slots(8, 15), slots(32, 39), slots(16, 23), slots(24, 31), null, null]);
    const fixtures = generateDivisionFixtures(world, comp, { year: 2026, month: 1 });
    for (const f of fixtures) {
      const dayOffset = Math.floor(((f.kickoffAt ?? 0) - SEASON_START) / DAY_MS);
      expect(dayOffset).toBe(roundDayIndex(f.round));
    }
  });
});

describe("validatePreferredHours", () => {
  it("accepts at least 8 hours of distinct slots and normalizes them", () => {
    const input = [...slots(34, 47), 0, 1]; // 8 hours spanning midnight
    expect(validatePreferredHours(input)).toEqual([...slots(0, 1), ...slots(34, 47)]);
    expect(validatePreferredHours(slots(10, 25))).toEqual(slots(10, 25));
  });

  it("rejects malformed or too-short selections", () => {
    expect(validatePreferredHours(slots(0, 14))).toBeNull(); // 7.5 hours
    expect(validatePreferredHours([...slots(0, 14), 0])).toBeNull(); // duplicate collapses below minimum
    expect(validatePreferredHours([0, 1, 48])).toBeNull();
    expect(validatePreferredHours([0, -1])).toBeNull();
    expect(validatePreferredHours(["0" as unknown as number])).toBeNull();
    expect(validatePreferredHours("evenings" as unknown as number[])).toBeNull();
  });
});
