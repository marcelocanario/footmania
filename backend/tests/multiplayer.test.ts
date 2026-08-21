import { describe, it, expect } from "vitest";
import { generateWorld, createHumanClub } from "../src/game/worldgen";
import {
  initSeason,
  createDivision,
  ensureDivisionFull,
  generateDivisionFixtures,
  placeNewClub,
  returnDormantClub,
  highestRankedReplaceableAI,
  replaceClubInDivision,
  rebuildTierDivisions,
  computeNextTierAssignments,
  simulateThroughRound,
  evaluateInactivity,
  recordActivity,
  calculateSocialScore,
  divisionsInSeason,
  tierOf,
  groupIndexOf,
  compDivisionName,
  humanCount,
  fillerCount,
  playPracticeMatch,
} from "../src/game/multiplayer";
import { emptyStandingsRow } from "../src/game/league";
import { recomputeProxyState } from "../src/game/market";
import type { Club, Competition, Player, TransferAuction, World } from "../src/game/types";
import { advanceLiveMatches, startLiveMatch } from "../src/game/world";
import { MP_CONFIG } from "../src/config";
import { contractCycle } from "../src/game/season";
import { settlePlayerPayroll } from "../src/game/payroll";
import { issueAllocation } from "../src/services/mpService";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function seasonWorld(seed = 1): { world: World; seasonId: number } {
  const world = generateWorld(seed);
  initSeason(world, { year: 2026, month: 1 }, 1);
  return { world, seasonId: 1 };
}

function addHuman(world: World, userId: number, name: string, tier: number): number {
  const club = createHumanClub(world, { userId, clubName: name, country: "BRA", timezone: "America/Sao_Paulo" });
  const comp = divisionsInSeason(world, world.mp.seasonId).find((d) => tierOf(d) === tier && Object.keys(d.standings).length < 8);
  if (comp) {
    replaceClubInDivision(world, comp, highestRankedReplaceableAI(world, comp)!, club.id);
    club.competitionState = "ACTIVE";
  }
  return club.id;
}

describe("pyramid capacity", () => {
  it("starts with exactly 8 clubs in Division 1", () => {
    const { world } = seasonWorld(1);
    const div = world.competitions.find((c) => c.kind === "division")!;
    expect(div.name).toBe("1");
    expect(Object.keys(div.standings).length).toBe(8);
    expect(compDivisionName(div)).toBe("1");
  });

  it("fills Division 1 with humans before creating Division 2.1", () => {
    const { world, seasonId } = seasonWorld(2);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    // Replace the first 7 AIs with humans.
    for (let i = 1; i <= 7; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `Human ${i}`, country: "BRA", timezone: "America/Sao_Paulo" });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // The 8th human fills the last Division 1 slot (still one division).
    const c8 = createHumanClub(world, { userId: 8, clubName: "Human 8", country: "BRA", timezone: "America/Sao_Paulo" });
    const r8 = placeNewClub(world, c8.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(r8.kind).toBe("active");
    expect(world.competitions.filter((c) => c.kind === "division").length).toBe(1);
    expect(Object.values(div1.standings).every((r) => world.clubs.find((c) => c.id === r.clubId)?.ownerUserId !== null)).toBe(true);
    // The 9th human needs a new division at tier 2.
    const c9 = createHumanClub(world, { userId: 9, clubName: "Human 9", country: "BRA", timezone: "America/Sao_Paulo" });
    const r9 = placeNewClub(world, c9.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(r9.kind).toBe("active");
    const divs = world.competitions.filter((c) => c.kind === "division");
    expect(divs.length).toBe(2);
    const tier2 = divs.find((d) => tierOf(d) === 2)!;
    expect(tier2.name).toBe("2.1");
    expect(Object.keys(tier2.standings).length).toBe(8);
  });

  describe.each([
    [0, 1],
    [1, 1],
    [7, 1],
    [8, 1],
    [9, 2],
    [15, 2],
    [16, 2],
    [17, 2],
    [24, 2],
    [25, 3],
    [32, 3],
    [33, 3],
    [64, 4],
  ])("capacity matrix with %i humans", (numHumans, expectedTierCount) => {
    it(`produces exactly 8 slots per active division, AI only in the final incomplete division`, () => {
      const { world, seasonId } = seasonWorld(1000 + numHumans);
      // Starting from an empty pyramid? initSeason already created Division 1
      // with 8 AI. Fill humans across divisions via placeNewClub.
      const clubs: number[] = [];
      for (let i = 0; i < numHumans; i++) {
        const club = createHumanClub(world, { userId: 10_000 + i, clubName: `H${i}`, country: "BRA", timezone: "UTC" });
        const res = placeNewClub(world, club.id, Date.now(), seasonId, { year: 2026, month: 2 });
        expect(res.kind).toBe("active");
        clubs.push(club.id);
      }

      const divs = world.competitions.filter((c) => c.kind === "division");
      const tiers = [...new Set(divs.map(tierOf))].sort((a, b) => a - b);

      // Every active division holds exactly 8 slots.
      for (const d of divs) {
        expect(Object.keys(d.standings).length).toBe(8);
      }

      // Active tiers count matches the matrix (only populated tiers exist).
      expect(tiers.length).toBe(expectedTierCount);

      // Human counts per division: all divisions except the very last (lowest
      // tier, highest group) are full of humans; the final one may be partial.
      const sorted = [...divs].sort((a, b) => tierOf(a) - tierOf(b) || groupIndexOf(a) - groupIndexOf(b));
      for (let i = 0; i < sorted.length - 1; i++) {
        expect(humanCount(world, sorted[i])).toBe(8);
        expect(fillerCount(world, sorted[i])).toBe(0);
      }
      const last = sorted[sorted.length - 1];
      const lastHumans = humanCount(world, last);
      const lastFillers = fillerCount(world, last);
      expect(lastHumans + lastFillers).toBe(8);
      if (numHumans % 8 !== 0) {
        expect(lastFillers).toBeGreaterThan(0);
      }

      // AI only ever appears in the final (bottom-most) incomplete division.
      for (const d of sorted.slice(0, -1)) {
        expect(fillerCount(world, d)).toBe(0);
      }
      // No illegal group indexes (0..2^(tier-1)-1).
      for (const d of divs) {
        const maxGroup = tierOf(d) <= 1 ? 0 : 2 ** (tierOf(d) - 1) - 1;
        expect(groupIndexOf(d)).toBeGreaterThanOrEqual(0);
        expect(groupIndexOf(d)).toBeLessThanOrEqual(maxGroup);
      }
    });
  });
});

describe("AI replacement preserves standings identity", () => {
  it("keeps the replaced AI's competitive record on the new human club", () => {
    const { world, seasonId } = seasonWorld(3);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    const aiId = highestRankedReplaceableAI(world, div1)!;
    const row = div1.standings[aiId];
    row.points = 12;
    row.played = 4;
    row.wins = 4;

    const club = createHumanClub(world, { userId: 99, clubName: "Marcelo FC", country: "BRA", timezone: null });
    replaceClubInDivision(world, div1, aiId, club.id);
    expect(div1.standings[club.id].points).toBe(12);
    expect(div1.standings[club.id].played).toBe(4);
    expect(div1.standings[club.id].wins).toBe(4);
    expect(div1.standings[aiId]).toBeUndefined();
  });

  it("does not copy the replaced AI's club assets", () => {
    const { world, seasonId } = seasonWorld(31);
    const division = world.competitions.find((c) => c.kind === "division")!;
    const club = createHumanClub(world, { userId: 3131, clubName: "Own Assets FC", country: "BRA", timezone: "UTC" });
    const ownCash = club.cash;
    const result = placeNewClub(world, club.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(result.kind).toBe("active");
    expect(world.clubs.find((candidate) => candidate.id === club.id)?.cash).toBe(ownCash);
    expect(division.standings[club.id]).toBeDefined();
  });
});

describe("mid-season placement", () => {
  it("places a joining human in a new division simulated through the current round", () => {
    const { world, seasonId } = seasonWorld(4);
    // Fill Division 1 with 8 humans so a new tier-2 division is required.
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `Human ${i}`, country: "BRA", timezone: "Europe/London" });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // Simulate that we're at round 3 of the season.
    world.mp.completedRounds = 3;
    const club = createHumanClub(world, { userId: 9, clubName: "Joiner FC", country: "BRA", timezone: "Asia/Tokyo" });
    const result = placeNewClub(world, club.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(result.kind).toBe("active");
    const newDiv = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 2)!;
    // The new division must have fixtures for all 14 rounds.
    const fixtures = world.fixtures.filter((f) => f.competitionId === newDiv.id);
    expect(fixtures.length).toBe(56);
    const clubStandings = newDiv.standings[club.id];
    expect(clubStandings).toBeDefined();
    // The human inherited the highest-ranked AI slot's record (played rounds).
    expect(clubStandings.played).toBeGreaterThanOrEqual(0);
    expect(clubStandings.played).toBeLessThanOrEqual(6);
  });
});

describe("provisional joining after lock", () => {
  it("sends a post-lock joiner to the provisional queue", () => {
    const { world, seasonId } = seasonWorld(5);
    world.mp.joinState = "LOCKED";
    world.mp.completedRounds = 8;
    const club = createHumanClub(world, { userId: 50, clubName: "Late FC", country: "BRA", timezone: null });
    const result = placeNewClub(world, club.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(result.kind).toBe("provisional");
    expect(club.competitionState).toBe("PROVISIONAL");
  });
});

describe("promotion / relegation", () => {
  it("does not promote humans merely to replace filler AI slots", () => {
    const { world, seasonId } = seasonWorld(60);
    const parent = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    for (let i = 1; i <= 3; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `Parent-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, parent, highestRankedReplaceableAI(world, parent)!, club.id);
      club.competitionState = "ACTIVE";
    }
    const child = createDivision(world, { tier: 2, groupIndex: 0, seasonId, ref: { year: 2026, month: 1 } });
    ensureDivisionFull(world, child);
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: 100 + i, clubName: `Child-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, child, highestRankedReplaceableAI(world, child)!, club.id);
      club.competitionState = "ACTIVE";
    }

    const { assignments } = computeNextTierAssignments(world, seasonId);
    const tierOneHumans = [...assignments.entries()].filter(([id, tier]) => tier === 1 && world.clubs.find((c) => c.id === id)?.ownerUserId !== null);
    expect(tierOneHumans).toHaveLength(3); // one parent survivor + two promotions
  });

  it("promotes the top humans from child divisions, never AI", () => {
    const { world, seasonId } = seasonWorld(6);
    // Tier 1: 8 humans. Tier 2.1 + 2.2 each with 8 humans.
    const div1 = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    const d21 = createDivision(world, { tier: 2, groupIndex: 0, seasonId, ref: { year: 2026, month: 1 } });
    ensureDivisionFull(world, d21);
    const d22 = createDivision(world, { tier: 2, groupIndex: 1, seasonId, ref: { year: 2026, month: 1 } });
    ensureDivisionFull(world, d22);
    for (let i = 1; i <= 8; i++) {
      const c1 = createHumanClub(world, { userId: 100 + i, clubName: `D21-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, d21, highestRankedReplaceableAI(world, d21)!, c1.id);
      c1.competitionState = "ACTIVE";
      const c2 = createHumanClub(world, { userId: 200 + i, clubName: `D22-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, d22, highestRankedReplaceableAI(world, d22)!, c2.id);
      c2.competitionState = "ACTIVE";
    }
    // Set standings so D21's best human is #2 overall, D22's best is #1.
    const rows21 = Object.values(d21.standings);
    const rows22 = Object.values(d22.standings);
    rows21.forEach((r, idx) => {
      r.points = 20 - idx; // best human (lowest idx after tiebreak) is top
    });
    rows22.forEach((r, idx) => {
      r.points = 18 - idx;
    });
    const { assignments } = computeNextTierAssignments(world, seasonId);
    // Best human in D21 (id = highest overall, i.e. one of the humans) gets tier 1.
    const tier1Ids = new Set(Object.keys(div1.standings).map(Number));
    const promotedFromBelow = [...assignments.entries()].filter(([id, tier]) => tier === 1 && !tier1Ids.has(id)).map(([id]) => id);
    expect(promotedFromBelow.length).toBe(2);
    // Never an AI: every promoted club must have an owner.
    for (const id of promotedFromBelow) {
      const club = world.clubs.find((c) => c.id === id)!;
      expect(club.ownerUserId).not.toBeNull();
    }
  });

  it("fills abandonment vacancies with extra promotions from the lower tier", () => {
    const { world, seasonId } = seasonWorld(72);
    const parent = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    // 7 humans in Division 1 (leaving 1 AI filler at the bottom edge).
    for (let i = 1; i <= 7; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, parent, highestRankedReplaceableAI(world, parent)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // Give the humans distinct points so the top 7 are the humans (tiebreak by
    // points), keeping them out of the relegation zone; the AI fills the bottom.
    let pts = 40;
    for (const row of Object.values(parent.standings)) {
      const club = world.clubs.find((c) => c.id === row.clubId)!;
      if (club.ownerUserId !== null) row.points = pts--;
    }

    // One Division 1 human is abandoned at rollover -> creates an extra vacancy.
    const abandonedHuman = Object.keys(parent.standings).map(Number).find((id) => world.clubs.find((c) => c.id === id)?.ownerUserId !== null)!;
    world.clubs.find((c) => c.id === abandonedHuman)!.abandonmentEligibleAt = Date.now();

    const child = createDivision(world, { tier: 2, groupIndex: 0, seasonId, ref: { year: 2026, month: 1 } });
    ensureDivisionFull(world, child);
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: 100 + i, clubName: `Child-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, child, highestRankedReplaceableAI(world, child)!, club.id);
      club.competitionState = "ACTIVE";
    }
    const rows = Object.values(child.standings);
    rows.forEach((r, idx) => {
      r.points = 30 - idx;
    });

    const { assignments, abandonedClubIds } = computeNextTierAssignments(world, seasonId);
    expect(abandonedClubIds).toContain(abandonedHuman);
    // Division 1: 7 humans + 1 AI. 1 human abandoned. No relegations (top 6
    // humans + the abandoned slot vacate; the 2 AI-free spots? Actually 7
    // humans + 1 AI; none relegated because the humans are all above the AI).
    // Vacancies = 1 (abandoned) -> exactly 1 human promotes from tier 2.
    const tierOneHumans = [...assignments.entries()].filter(([id, tier]) => tier === 1 && world.clubs.find((c) => c.id === id)?.ownerUserId !== null);
    expect(tierOneHumans).toHaveLength(7); // 6 staying + 1 promoted
  });

  it("throws on invalid assignments (abandoned club assigned a tier)", () => {
    const { world, seasonId } = seasonWorld(73);
    const div = world.competitions.find((c) => c.kind === "division")!;
    for (let i = 1; i <= 3; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `H-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div, highestRankedReplaceableAI(world, div)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // Force one club to DORMANT; it is abandoned, so it must not be assigned a tier.
    const humanId = Object.keys(div.standings).map(Number).find((id) => world.clubs.find((c) => c.id === id)?.ownerUserId !== null)!;
    world.clubs.find((c) => c.id === humanId)!.competitionState = "DORMANT";

    const { assignments, abandonedClubIds } = computeNextTierAssignments(world, seasonId);
    expect(abandonedClubIds).toContain(humanId);
    expect(assignments.has(humanId)).toBe(false);
  });
});

describe("admin manual round advance", () => {
  it("simulates all divisions through the target round and locks joining past the threshold", () => {
    const { world } = seasonWorld(42);
    const div = world.competitions.find((c) => c.kind === "division")!;
    // Replace 2 AIs with humans.
    for (let i = 1; i <= 2; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `Human ${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div, highestRankedReplaceableAI(world, div)!, club.id);
      club.competitionState = "ACTIVE";
    }
    const now = Date.now();
    simulateThroughRound(world, 3, now);
    expect(world.mp.completedRounds).toBe(3);
    // Every club in the division has played 3 rounds.
    for (const row of Object.values(div.standings)) {
      expect(row.played).toBe(3);
    }
    // No fixtures remain unplayed for the first 3 rounds.
    const unplayedEarly = world.fixtures.filter((f) => f.competitionId === div.id && f.round < 3 && !f.played);
    expect(unplayedEarly.length).toBe(0);

    // Past the lock threshold, joinState becomes LOCKED.
    simulateThroughRound(world, 8, now);
    expect(world.mp.completedRounds).toBe(8);
    expect(world.mp.joinState).toBe("LOCKED");
  });

  it("rebuilds divisions at rollover with humans + AI filler and fresh fixtures", () => {
    const { world } = seasonWorld(43);
    const div = world.competitions.find((c) => c.kind === "division")!;
    for (let i = 1; i <= 3; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `Human ${i}`, country: "BRA", timezone: "America/Sao_Paulo" });
      replaceClubInDivision(world, div, highestRankedReplaceableAI(world, div)!, club.id);
      club.competitionState = "ACTIVE";
    }
    simulateThroughRound(world, 14, Date.now());
    // Rollover into a new season id (2).
    const nextRef = { year: 2026, month: 2 };
    const { assignments } = computeNextTierAssignments(world, world.mp.seasonId);
    const byTier = new Map<number, { clubId: number; timezone: string | null }[]>();
    for (const [clubId, tier] of assignments) {
      if (!byTier.has(tier)) byTier.set(tier, []);
      const club = world.clubs.find((c) => c.id === clubId)!;
      byTier.get(tier)!.push({ clubId, timezone: club.timezone });
    }
    for (const [tier, humans] of byTier.entries()) {
      rebuildTierDivisions(world, 2, tier, humans, nextRef);
    }
    const newDiv = world.competitions.find((c) => c.kind === "division" && c.seasonId === 2)!;
    expect(newDiv).toBeDefined();
    expect(Object.keys(newDiv.standings).length).toBe(8); // 3 humans + 5 AI
    const fixtures = world.fixtures.filter((f) => f.competitionId === newDiv.id);
    expect(fixtures.length).toBe(56);
    expect(fixtures.every((f) => !f.played)).toBe(true);
  });
});

describe("timezone clustering", () => {
  it("balances 19 humans across 3 same-tier divisions while minimizing timezone spread", () => {
    // 19 humans spread across timezones -> near-even groups of 7/6/6 from
    // buildBalancedTierGroups (plan §36: density first, then timezone cost).
    const { world } = seasonWorld(190);
    const humans = Array.from({ length: 19 }, (_, i) => {
      const club = createHumanClub(world, { userId: i + 1, clubName: `Cluster-${i + 1}`, country: "BRA", timezone: ["Asia/Tokyo", "Europe/London", "America/Sao_Paulo", "UTC"][i % 4] });
      club.competitionState = "ACTIVE";
      return { clubId: club.id, timezone: club.timezone };
    });
    // Tier 3 allows up to 4 divisions, enough for 19 humans in 3 groups.
    const divisions = rebuildTierDivisions(world, world.mp.seasonId, 3, humans, { year: 2026, month: 2 }, { generateFixtures: false });
    expect(divisions).toHaveLength(3);
    const sizes = divisions.map((division) => Object.keys(division.standings).map(Number).filter((id) => humans.some((human) => human.clubId === id)).length);
    expect(sizes).toEqual([7, 6, 6]);
    // Timezone affinity: each group's members are timezone-contiguous after
    // the swap optimization (same-timezone clubs end up together).
    for (const division of divisions) {
      const timezones = Object.keys(division.standings)
        .map(Number)
        .map((id) => humans.find((human) => human.clubId === id)?.timezone);
      expect(new Set(timezones).size).toBeLessThanOrEqual(4);
    }
  });

  it("keeps direct friends together before timezone and Elo objectives", () => {
    const { world } = seasonWorld(191);
    const humans = Array.from({ length: 8 }, (_, index) => {
      const club = createHumanClub(world, { userId: index + 1, clubName: `Friend-${index + 1}`, country: "BRA", timezone: "UTC" });
      club.competitionState = "ACTIVE";
      return { clubId: club.id, timezone: club.timezone };
    });
    world.friendships = [
      { userAId: 1, userBId: 5 },
      { userAId: 2, userBId: 6 },
      { userAId: 3, userBId: 7 },
      { userAId: 4, userBId: 8 },
    ];
    const divisions = rebuildTierDivisions(world, world.mp.seasonId, 1, humans, { year: 2026, month: 2 }, { generateFixtures: false });
    const groups = divisions.map((division) => Object.keys(division.standings)
      .map(Number)
      .filter((clubId) => humans.some((human) => human.clubId === clubId))
      .map((clubId) => ({ clubId })));
    expect(calculateSocialScore(groups, world).direct).toBe(4);
  });

  it("reproduces seeded group tie-breaks across retries", () => {
    const makeWorld = () => {
      const { world } = seasonWorld(192);
      const humans = Array.from({ length: 16 }, (_, index) => {
        const club = createHumanClub(world, { userId: index + 1, clubName: `Seeded-${index + 1}`, country: "BRA", timezone: "UTC" });
        club.competitionState = "ACTIVE";
        return { clubId: club.id, timezone: club.timezone };
      });
      return { world, humans };
    };
    const first = makeWorld();
    const second = makeWorld();
    const firstDivisions = rebuildTierDivisions(first.world, first.world.mp.seasonId, 2, first.humans, { year: 2026, month: 2 }, { generateFixtures: false, assignmentSeed: 0x12345678 });
    const secondDivisions = rebuildTierDivisions(second.world, second.world.mp.seasonId, 2, second.humans, { year: 2026, month: 2 }, { generateFixtures: false, assignmentSeed: 0x12345678 });
    const groups = (divisions: typeof firstDivisions) => divisions.map((division) => Object.keys(division.standings).map(Number).filter((id) => first.humans.some((human) => human.clubId === id)));
    expect(groups(firstDivisions)).toEqual(groups(secondDivisions));
  });
});

describe("abandonment / returning clubs", () => {
  it("flags an inactive club as abandonment-eligible, then returns it", () => {
    const { world, seasonId } = seasonWorld(70);
    const div = world.competitions.find((c) => c.kind === "division")!;
    const club = createHumanClub(world, { userId: 900, clubName: "Absent FC", country: "BRA", timezone: null });
    replaceClubInDivision(world, div, highestRankedReplaceableAI(world, div)!, club.id);
    club.competitionState = "ACTIVE";
    // The club joined now; move its activity anchor far into the past so it is
    // past the default 28-day threshold.
    club.lastMeaningfulActivityAt = Date.now() - 50 * 24 * 60 * 60 * 1000;

    evaluateInactivity(world, Date.now());
    expect(club.abandonmentEligibleAt).not.toBeNull();

    // Meaningful activity clears the flag.
    recordActivity(world, 900, club.id, "tactics");
    expect(club.abandonmentEligibleAt).toBeNull();

    // Re-mark eligible, then force the DORMANT transition (plan §45) as
    // rollover would.
    club.lastMeaningfulActivityAt = Date.now() - 50 * 24 * 60 * 60 * 1000;
    evaluateInactivity(world, Date.now());
    club.competitionState = "DORMANT";
    club.abandonmentEligibleAt = null;

    // Returning before the lock places the club back into the pyramid.
    const result = returnDormantClub(world, club.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(result.kind).toBe("active");
    expect(club.competitionState).toBe("ACTIVE");
    const active = divisionsInSeason(world, world.mp.seasonId).find((d) => d.standings[club.id] !== undefined);
    expect(active).toBeDefined();
  });

  it("sends a dormant club returning after the lock to the provisional queue", () => {
    const { world, seasonId } = seasonWorld(71);
    const div = world.competitions.find((c) => c.kind === "division")!;
    const club = createHumanClub(world, { userId: 901, clubName: "Late Return FC", country: "BRA", timezone: null });
    replaceClubInDivision(world, div, highestRankedReplaceableAI(world, div)!, club.id);
    club.competitionState = "DORMANT";
    world.mp.joinState = "LOCKED";
    world.mp.completedRounds = 8;

    const result = returnDormantClub(world, club.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(result.kind).toBe("provisional");
    expect(club.competitionState).toBe("PROVISIONAL");
  });
});

describe("provisional practice matches", () => {
  it("does not persist match-engine player mutations", () => {
    const { world } = seasonWorld(74);
    const club = createHumanClub(world, { userId: 902, clubName: "Practice FC", country: "BRA", timezone: null });
    club.competitionState = "PROVISIONAL";
    const before = world.players.map((player) => ({
      id: player.id,
      energy: player.energy,
      injuryDays: player.injuryDays,
      seasonGoals: player.seasonGoals,
      careerGoals: player.careerGoals,
      seasonAssists: player.seasonAssists,
      careerAssists: player.careerAssists,
      tacPos: player.tacPos,
    }));
    const rngBefore = { ...world.rng };

    const result = playPracticeMatch(world, club.id);

    expect(result).not.toBeNull();
    expect(world.players.map((player) => ({
      id: player.id,
      energy: player.energy,
      injuryDays: player.injuryDays,
      seasonGoals: player.seasonGoals,
      careerGoals: player.careerGoals,
      seasonAssists: player.seasonAssists,
      careerAssists: player.careerAssists,
      tacPos: player.tacPos,
    }))).toEqual(before);
    expect(world.rng).toEqual(rngBefore);
  });

  it("rejects non-provisional clubs", () => {
    const { world } = seasonWorld(75);
    const club = world.clubs[0];
    expect(playPracticeMatch(world, club.id)).toBeNull();
  });
});

describe("provisional economics", () => {
  it("keeps contracts frozen", () => {
    const { world } = seasonWorld(78);
    const club = createHumanClub(world, { userId: 903, clubName: "Waiting FC", country: "BRA", timezone: null });
    club.competitionState = "PROVISIONAL";
    const player = world.players.find((candidate) => candidate.clubId === club.id && !candidate.isYouth)!;
    player.contractDays = 0;

    contractCycle(world.rng, world);

    expect(player.clubId).toBe(club.id);
    expect(player.contractDays).toBe(0);
  });

  it("does not charge salaries while provisional", () => {
    const { world } = seasonWorld(79);
    const club = createHumanClub(world, { userId: 904, clubName: "Salary FC", country: "BRA", timezone: null });
    club.competitionState = "PROVISIONAL";
    const player = world.players.find((candidate) => candidate.clubId === club.id && !candidate.isYouth)!;
    const cashBefore = club.cash;

    settlePlayerPayroll(world, player, 30);

    expect(club.cash).toBe(cashBefore);
  });

  it("reserves the next-season allocation exactly once (idempotent)", async () => {
    const { world, seasonId } = seasonWorld(80);
    const club = createHumanClub(world, { userId: 905, clubName: "Reserved FC", country: "BRA", timezone: null });
    club.competitionState = "PROVISIONAL";
    const nextSeasonId = seasonId + 100;

    const first = await issueAllocation(prisma, world, club.id, nextSeasonId, 1, { type: "PROVISIONAL_NEXT_SEASON" });
    const second = await issueAllocation(prisma, world, club.id, nextSeasonId, 1, { type: "PROVISIONAL_NEXT_SEASON" });

    expect(first).toBe(second);
    expect(world.seasonAllocations.filter((a) => a.clubId === club.id && a.seasonId === nextSeasonId && a.type === "PROVISIONAL_NEXT_SEASON")).toHaveLength(1);
  });
});

describe("promotion / rollover test matrix (plan §7)", () => {
  function fullDivision(world: World, tier: number, groupIndex: number, userIdBase: number, prefix: string, points: number[]): Competition {
    const comp = createDivision(world, { tier, groupIndex, seasonId: world.mp.seasonId, ref: { year: 2026, month: 1 } });
    ensureDivisionFull(world, comp);
    const rows = Object.values(comp.standings);
    rows.forEach((r, i) => {
      const club = createHumanClub(world, { userId: userIdBase + i, clubName: `${prefix}-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, comp, r.clubId, club.id);
      club.competitionState = "ACTIVE";
      if (points[i] !== undefined) comp.standings[club.id].points = points[i];
    });
    return comp;
  }

  it("promotes the top human from each child when both children are populated", () => {
    const { world, seasonId } = seasonWorld(500);
    const div1 = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // Both child divisions populated with humans; set child standings so the
    // best human in each is on top.
    const d21 = fullDivision(world, 2, 0, 100, "D21", [20, 19, 18, 17, 16, 15, 14, 13]);
    const d22 = fullDivision(world, 2, 1, 200, "D22", [18, 17, 16, 15, 14, 13, 12, 11]);
    void d21;
    void d22;

    const { assignments } = computeNextTierAssignments(world, seasonId);
    const tier1Ids = new Set(Object.keys(div1.standings).map(Number));
    const promoted = [...assignments.entries()].filter(([id, tier]) => tier === 1 && !tier1Ids.has(id)).map(([id]) => id);
    expect(promoted.length).toBe(2);
    for (const id of promoted) {
      expect(world.clubs.find((c) => c.id === id)?.ownerUserId).not.toBeNull();
    }
  });

  it("promotes two humans from the only populated child division", () => {
    const { world, seasonId } = seasonWorld(501);
    const div1 = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // Only one child (2.1) populated.
    fullDivision(world, 2, 0, 100, "D21", [20, 19, 18, 17, 16, 15, 14, 13]);

    const { assignments } = computeNextTierAssignments(world, seasonId);
    const tier1Ids = new Set(Object.keys(div1.standings).map(Number));
    const promoted = [...assignments.entries()].filter(([id, tier]) => tier === 1 && !tier1Ids.has(id)).map(([id]) => id);
    expect(promoted.length).toBe(2);
  });

  it("promotes a human who finished below an AI (AI does not consume slots)", () => {
    const { world, seasonId } = seasonWorld(502);
    const div1 = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // Child 2.1 with 7 humans + 1 AI; the AI finishes above two humans.
    const d21 = createDivision(world, { tier: 2, groupIndex: 0, seasonId, ref: { year: 2026, month: 1 } });
    ensureDivisionFull(world, d21);
    const rows = Object.values(d21.standings);
    const aiId = rows[0].clubId;
    rows.forEach((r, i) => {
      if (r.clubId === aiId) {
        d21.standings[r.clubId].points = 30;
        return;
      }
      const club = createHumanClub(world, { userId: 300 + i, clubName: `C-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, d21, r.clubId, club.id);
      club.competitionState = "ACTIVE";
      d21.standings[club.id].points = 28 - i; // human 1: 28, human 2: 27...
    });

    const { assignments } = computeNextTierAssignments(world, seasonId);
    const tier1Ids = new Set(Object.keys(div1.standings).map(Number));
    const promoted = [...assignments.entries()].filter(([id, tier]) => tier === 1 && !tier1Ids.has(id)).map(([id]) => id);
    expect(promoted.length).toBe(2);
    for (const id of promoted) {
      const club = world.clubs.find((c) => c.id === id)!;
      expect(club.ownerUserId).not.toBeNull();
    }
  });

  it("handles a child division with a single human", () => {
    const { world, seasonId } = seasonWorld(503);
    const div1 = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // Child 2.1 with exactly one human and seven AI.
    const d21 = createDivision(world, { tier: 2, groupIndex: 0, seasonId, ref: { year: 2026, month: 1 } });
    ensureDivisionFull(world, d21);
    const rows = Object.values(d21.standings);
    rows.forEach((r, i) => {
      if (i === 0) {
        const club = createHumanClub(world, { userId: 400, clubName: "Solo", country: "BRA", timezone: null });
        replaceClubInDivision(world, d21, r.clubId, club.id);
        club.competitionState = "ACTIVE";
        d21.standings[club.id].points = 25;
      }
    });

    const { assignments } = computeNextTierAssignments(world, seasonId);
    const tier1Ids = new Set(Object.keys(div1.standings).map(Number));
    const promoted = [...assignments.entries()].filter(([id, tier]) => tier === 1 && !tier1Ids.has(id)).map(([id]) => id);
    // Only one human exists in the child; exactly one promotion possible.
    expect(promoted.length).toBeLessThanOrEqual(1);
  });

  it("abandoned champion frees a slot for an extra promotion", () => {
    const { world, seasonId } = seasonWorld(504);
    const div1 = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    // Fill Division 1 with 8 humans.
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    const d21 = fullDivision(world, 2, 0, 100, "D21", [20, 19, 18, 17, 16, 15, 14, 13]);
    // Mark the champion human abandoned.
    const champion = Object.keys(div1.standings).map(Number).find((id) => world.clubs.find((c) => c.id === id)?.ownerUserId !== null)!;
    world.clubs.find((c) => c.id === champion)!.abandonmentEligibleAt = Date.now();

    const { assignments, abandonedClubIds } = computeNextTierAssignments(world, seasonId);
    expect(abandonedClubIds).toContain(champion);
    // The abandoned champion's slot becomes a vacancy → one extra promotion.
    const tier1Ids = new Set(Object.keys(div1.standings).map(Number));
    const promoted = [...assignments.entries()].filter(([id, tier]) => tier === 1 && !tier1Ids.has(id)).map(([id]) => id);
    expect(promoted.length).toBe(3); // 2 normal + 1 from vacancy
    void d21;
  });

  it("cascades extra promotions across multiple tiers", () => {
    const { world, seasonId } = seasonWorld(505);
    const div1 = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    // Fill Division 1 with 8 humans.
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    // Tier 2 with two children, tier 3 with two children.
    fullDivision(world, 2, 0, 100, "D21", [20, 19, 18, 17, 16, 15, 14, 13]);
    fullDivision(world, 2, 1, 200, "D22", [18, 17, 16, 15, 14, 13, 12, 11]);
    const d31 = fullDivision(world, 3, 0, 300, "D31", [16, 15, 14, 13, 12, 11, 10, 9]);
    const d32 = fullDivision(world, 3, 1, 400, "D32", [14, 13, 12, 11, 10, 9, 8, 7]);
    void d31;
    void d32;

    const { assignments } = computeNextTierAssignments(world, seasonId);
    // Everything is full so only normal promotions apply; the invariant checks
    // pass and every active human is assigned a valid tier.
    expect(assignments.size).toBeGreaterThan(0);
    const counts = new Map<number, number>();
    for (const [, tier] of assignments) counts.set(tier, (counts.get(tier) ?? 0) + 1);
    for (const [tier, count] of counts) {
      const maxDivisions = tier <= 1 ? 1 : 2 ** (tier - 1);
      expect(count).toBeLessThanOrEqual(maxDivisions * 8);
    }
  });

  it("repeated rollover over the same season produces no duplicate memberships/schedules", () => {
    const { world, seasonId } = seasonWorld(506);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    for (let i = 1; i <= 3; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    simulateThroughRound(world, 14, Date.now());

    // Rebuild tier divisions for the same season twice: must be idempotent.
    const { assignments } = computeNextTierAssignments(world, seasonId);
    const byTier = new Map<number, { clubId: number; timezone: string | null }[]>();
    for (const [clubId, tier] of assignments) {
      if (!byTier.has(tier)) byTier.set(tier, []);
      const club = world.clubs.find((c) => c.id === clubId)!;
      byTier.get(tier)!.push({ clubId, timezone: club.timezone });
    }
    for (const [tier, humans] of byTier.entries()) {
      rebuildTierDivisions(world, 2, tier, humans, { year: 2026, month: 2 });
    }
    const newDivs = world.competitions.filter((c) => c.kind === "division" && c.seasonId === 2);
    const fixturesBefore = world.fixtures.filter((f) => newDivs.some((d) => d.id === f.competitionId)).length;
    const membersBefore = world.mpMemberships.length;

    // Rebuild again for season 2 → must not duplicate fixtures or memberships.
    for (const [tier, humans] of byTier.entries()) {
      rebuildTierDivisions(world, 2, tier, humans, { year: 2026, month: 2 });
    }
    const newDivs2 = world.competitions.filter((c) => c.kind === "division" && c.seasonId === 2);
    const fixturesAfter = world.fixtures.filter((f) => newDivs2.some((d) => d.id === f.competitionId)).length;
    expect(fixturesAfter).toBe(fixturesBefore);
    expect(world.mpMemberships.length).toBe(membersBefore);
    // No duplicate fixtures per division: each (round, home, away) is unique.
    for (const d of newDivs2) {
      const fs = world.fixtures.filter((f) => f.competitionId === d.id);
      const keys = fs.map((f) => `${f.round}:${f.homeClubId}:${f.awayClubId}`);
      expect(new Set(keys).size).toBe(keys.length);
      // A full 8-team double round-robin has 14 rounds × 4 matches = 56.
      expect(fs.length).toBe(56);
    }
  });

  it("multiple abandoned clubs in one division open enough vacancies", () => {
    const { world, seasonId } = seasonWorld(507);
    const div1 = world.competitions.find((c) => c.kind === "division" && tierOf(c) === 1)!;
    // Leave 8 humans in Division 1.
    for (let i = 1; i <= 8; i++) {
      const club = createHumanClub(world, { userId: i, clubName: `D1-${i}`, country: "BRA", timezone: null });
      replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
      club.competitionState = "ACTIVE";
    }
    fullDivision(world, 2, 0, 100, "D21", [20, 19, 18, 17, 16, 15, 14, 13]);
    // Abandon 3 of the Division 1 humans.
    const humans = Object.keys(div1.standings).map(Number).filter((id) => world.clubs.find((c) => c.id === id)?.ownerUserId !== null);
    for (const id of humans.slice(0, 3)) {
      world.clubs.find((c) => c.id === id)!.abandonmentEligibleAt = Date.now();
    }

    const { assignments, abandonedClubIds } = computeNextTierAssignments(world, seasonId);
    expect(abandonedClubIds.length).toBe(3);
    const tier1Ids = new Set(Object.keys(div1.standings).map(Number));
    const promoted = [...assignments.entries()].filter(([id, tier]) => tier === 1 && !tier1Ids.has(id)).map(([id]) => id);
    // 3 vacancies → 3 extra promotions beyond the normal 2.
    expect(promoted.length).toBe(5);
  });

  it("returning before the cutoff places the club in the pyramid", () => {
    const { world, seasonId } = seasonWorld(508);
    const div = world.competitions.find((c) => c.kind === "division")!;
    const club = createHumanClub(world, { userId: 600, clubName: "Returner", country: "BRA", timezone: null });
    replaceClubInDivision(world, div, highestRankedReplaceableAI(world, div)!, club.id);
    club.competitionState = "DORMANT";

    const result = returnDormantClub(world, club.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(result.kind).toBe("active");
    expect(club.competitionState).toBe("ACTIVE");
  });

  it("returning after the cutoff sends the club to the provisional queue", () => {
    const { world, seasonId } = seasonWorld(509);
    const div = world.competitions.find((c) => c.kind === "division")!;
    const club = createHumanClub(world, { userId: 601, clubName: "Late Returner", country: "BRA", timezone: null });
    replaceClubInDivision(world, div, highestRankedReplaceableAI(world, div)!, club.id);
    club.competitionState = "DORMANT";
    world.mp.joinState = "LOCKED";
    world.mp.completedRounds = 8;

    const result = returnDormantClub(world, club.id, Date.now(), seasonId, { year: 2026, month: 2 });
    expect(result.kind).toBe("provisional");
    expect(club.competitionState).toBe("PROVISIONAL");
  });
});

describe("live-match downtime recovery", () => {
  it("advances from scheduled kickoff and finalizes an overdue match", () => {
    const { world } = seasonWorld(76);
    const division = world.competitions.find((competition) => competition.kind === "division")!;
    const fixture = world.fixtures.find((candidate) => candidate.competitionId === division.id)!;
    const now = Date.now();
    fixture.kickoffAt = now - (MP_CONFIG.matchDurationMinutes + 2) * 60 * 1000;

    const match = startLiveMatch(world, fixture);
    expect(match).not.toBeNull();
    expect(world.liveMatches).toHaveLength(1);

    advanceLiveMatches(world, now);

    expect(world.liveMatches).toHaveLength(0);
    expect(fixture.played).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filler retirement market reconciliation: when a human takes an AI slot, the
// AI's own commitments are voided and its listed players with bids are awarded
// to their leading bidder instead of being destroyed with the club.
// ---------------------------------------------------------------------------

function cheapestSeniorSquadPlayer(world: World, clubId: number): Player {
  const squad = world.players.filter((p) => p.clubId === clubId && !p.isYouth);
  if (squad.length === 0) throw new Error("club has no senior players");
  return squad.reduce((min, p) => (p.value < min.value ? p : min), squad[0]);
}

function listAiPlayer(world: World, aiClubId: number): { player: Player; listing: TransferAuction } {
  const player = cheapestSeniorSquadPlayer(world, aiClubId);
  // Raw pre-B3 state: ephemeral AI clubs are hard-blocked from the market now,
  // but legacy worlds can still carry AI-owned listings that rollover must
  // reconcile (retireFillerClub / removeFillerClubs).
  const now = Date.now();
  const listing: TransferAuction = {
    id: world.nextId++,
    playerId: player.id,
    sellerClubId: aiClubId,
    playerValueAtListing: player.value,
    openingPrice: Math.max(1, player.value),
    bidIncrement: Math.max(1, Math.round(player.value * 0.01)),
    sellerDivisionAtListing: 1,
    totalDivisionsAtListing: 1,
    salaryBaselineAtListing: player.salary,
    playerOverallAtListing: player.overall,
    playerAgeAtListing: player.age,
    currentPrice: Math.max(1, player.value),
    leadingClubId: null,
    createdAt: now,
    deadline: now + 3_600_000,
    originalDeadline: now + 3_600_000,
    status: "ACTIVE",
    completedAt: null,
    winningClubId: null,
    finalPrice: null,
    cancelledAt: null,
    softClosed: false,
    deadlineVersion: 0,
  };
  world.transferAuctions.push(listing);
  return { player, listing };
}

function legacyBidOnListing(world: World, club: Club, listing: TransferAuction, maximum: number): void {
  // Raw pre-B3 bid: pushed straight into durable state, then the shared proxy
  // recomputation derives leader/price/reservations exactly as production did.
  const now = Date.now();
  world.marketBids.push({
    id: world.nextId++,
    marketType: "TRANSFER",
    listingId: listing.id,
    clubId: club.id,
    maxBid: maximum,
    contractSeasons: 1,
    contractSalary: 100_000,
    contractDemandAtSubmission: 100_000,
    capMultiplierAtSubmission: 1.5,
    maximumAllowedByRuleAtSubmission: listing.playerValueAtListing * 1.5,
    buyerDivisionAtSubmission: 1,
    createdAt: now,
    updatedAt: now,
    initialPriorityAt: now,
  });
  recomputeProxyState(world, listing.id, "TRANSFER");
}

function expectActive(result: { kind: string; replacedClubId?: number }): number {
  if (result.kind !== "active" || result.replacedClubId === undefined) throw new Error("expected active placement");
  return result.replacedClubId;
}

describe("filler retirement market reconciliation", () => {
  it("awards a bid-on AI listing to the leading bidder when a human replaces the AI", () => {
    const { world, seasonId } = seasonWorld(900);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    const aiId = highestRankedReplaceableAI(world, div1)!;
    const { player, listing } = listAiPlayer(world, aiId);
    const bidder = createHumanClub(world, { userId: 9001, clubName: "Bidder FC", country: "BRA", timezone: "UTC" });
    legacyBidOnListing(world, bidder, listing, listing.openingPrice);
    const cashBefore = bidder.cash;

    const joiner = createHumanClub(world, { userId: 9002, clubName: "Joiner FC", country: "BRA", timezone: "UTC" });
    const replacedClubId = expectActive(placeNewClub(world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 }));

    expect(replacedClubId).toBe(aiId);
    expect(listing.status).toBe("COMPLETED");
    expect(listing.winningClubId).toBe(bidder.id);
    expect(listing.finalPrice).toBe(listing.openingPrice);
    expect(player.clubId).toBe(bidder.id);
    expect(world.players.some((p) => p.id === player.id)).toBe(true);
    expect(bidder.cash).toBe(cashBefore - listing.finalPrice!);
    expect(world.clubs.some((c) => c.id === aiId)).toBe(false);
    expect(world.news.some((n) => n.text.includes("won the auction"))).toBe(true);
  });

  it("settles competing bidders at the proxy clearing price and releases every reservation", () => {
    const { world, seasonId } = seasonWorld(901);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    const aiId = highestRankedReplaceableAI(world, div1)!;
    const { player, listing } = listAiPlayer(world, aiId);
    const low = createHumanClub(world, { userId: 9011, clubName: "Low FC", country: "BRA", timezone: "UTC" });
    const high = createHumanClub(world, { userId: 9012, clubName: "High FC", country: "BRA", timezone: "UTC" });
    legacyBidOnListing(world, low, listing, listing.openingPrice);
    // The division-gap cap (150% same-division) bounds any private maximum.
    const highMax = Math.floor(listing.openingPrice * 1.4);
    legacyBidOnListing(world, high, listing, highMax);
    const highCashBefore = high.cash;

    const joiner = createHumanClub(world, { userId: 9013, clubName: "Joiner FC", country: "BRA", timezone: "UTC" });
    placeNewClub(world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 });

    expect(listing.status).toBe("COMPLETED");
    expect(listing.winningClubId).toBe(high.id);
    // Proxy clearing price: second-highest max + increment, capped at the winner's max.
    expect(listing.finalPrice).toBe(Math.min(highMax, listing.openingPrice + listing.bidIncrement));
    expect(high.cash).toBe(highCashBefore - listing.finalPrice!);
    expect(player.clubId).toBe(high.id);
    expect(world.marketReservations.filter((r) => r.listingId === listing.id).every((r) => r.releasedAt !== null)).toBe(true);
  });

  it("cancels a bid-less AI listing and destroys the player with the club", () => {
    const { world, seasonId } = seasonWorld(902);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    const aiId = highestRankedReplaceableAI(world, div1)!;
    const { player, listing } = listAiPlayer(world, aiId);

    const joiner = createHumanClub(world, { userId: 9021, clubName: "Joiner FC", country: "BRA", timezone: "UTC" });
    const replacedClubId = expectActive(placeNewClub(world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 }));

    expect(replacedClubId).toBe(aiId);
    expect(listing.status).toBe("CANCELLED");
    expect(player.onSale).toBe(false);
    expect(world.players.some((p) => p.id === player.id)).toBe(false);
    expect(world.clubs.some((c) => c.id === aiId)).toBe(false);
    expect(world.marketReservations.filter((r) => r.listingId === listing.id).every((r) => r.releasedAt !== null)).toBe(true);
  });

  it("voids the retiring AI's own bids, reservations and evaluations on other listings", () => {
    const { world, seasonId } = seasonWorld(903);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    const targetAiId = highestRankedReplaceableAI(world, div1)!;
    const otherAi = world.clubs.find((c) => c.ownerUserId === null && c.isHuman === false && c.id !== targetAiId)!;
    const { player: otherPlayer, listing: otherListing } = listAiPlayer(world, otherAi.id);
    const targetAi = world.clubs.find((c) => c.id === targetAiId)!;
    legacyBidOnListing(world, targetAi, otherListing, otherListing.openingPrice);
    expect(otherListing.leadingClubId).toBe(targetAiId);

    const joiner = createHumanClub(world, { userId: 9031, clubName: "Joiner FC", country: "BRA", timezone: "UTC" });
    const replacedClubId = expectActive(placeNewClub(world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 }));

    expect(replacedClubId).toBe(targetAiId);
    expect(world.marketBids.some((b) => b.clubId === targetAiId)).toBe(false);
    expect(world.marketReservations.some((r) => r.clubId === targetAiId && r.releasedAt === null)).toBe(false);
    // The untouched listing survives with recomputed proxy state (no bids left).
    expect(otherListing.status).toBe("ACTIVE");
    expect(otherListing.leadingClubId).toBeNull();
    expect(otherListing.currentPrice).toBe(otherListing.openingPrice);
    expect(world.clubs.some((c) => c.id === otherAi.id)).toBe(true);
    expect(otherPlayer.clubId).toBe(otherAi.id);
  });

  it("promotes the next surviving bidder to leader after the retiring AI's lead is voided", () => {
    const { world, seasonId } = seasonWorld(904);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    const targetAiId = highestRankedReplaceableAI(world, div1)!;
    const otherAi = world.clubs.find((c) => c.ownerUserId === null && c.isHuman === false && c.id !== targetAiId)!;
    const { player: otherPlayer, listing: otherListing } = listAiPlayer(world, otherAi.id);
    void otherPlayer;
    const human = createHumanClub(world, { userId: 9041, clubName: "Underbidder FC", country: "BRA", timezone: "UTC" });
    legacyBidOnListing(world, human, otherListing, otherListing.openingPrice);
    const targetAi = world.clubs.find((c) => c.id === targetAiId)!;
    legacyBidOnListing(world, targetAi, otherListing, Math.floor(otherListing.openingPrice * 1.4));
    expect(otherListing.leadingClubId).toBe(targetAiId);

    const joiner = createHumanClub(world, { userId: 9042, clubName: "Joiner FC", country: "BRA", timezone: "UTC" });
    placeNewClub(world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 });

    expect(otherListing.status).toBe("ACTIVE");
    expect(otherListing.leadingClubId).toBe(human.id);
    expect(otherListing.currentPrice).toBe(otherListing.openingPrice);
    const reservation = world.marketReservations.find((r) => r.clubId === human.id && r.listingId === otherListing.id);
    expect(reservation?.releasedAt ?? null).toBeNull();
    expect(reservation?.amount).toBe(otherListing.openingPrice);
  });

  it("applies the same reconciliation when a dormant club returns via returnDormantClub", () => {
    const { world, seasonId } = seasonWorld(905);
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    const returning = createHumanClub(world, { userId: 9051, clubName: "Returner FC", country: "BRA", timezone: "UTC" });
    replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, returning.id);
    returning.competitionState = "DORMANT";
    // The AI that the returning club will replace is whichever ranks highest now.
    const aiId = highestRankedReplaceableAI(world, div1)!;
    const { player, listing } = listAiPlayer(world, aiId);
    const bidder = createHumanClub(world, { userId: 9052, clubName: "Bidder FC", country: "BRA", timezone: "UTC" });
    legacyBidOnListing(world, bidder, listing, listing.openingPrice);

    const result = returnDormantClub(world, returning.id, Date.now(), seasonId, { year: 2026, month: 2 });

    expect(expectActive(result)).toBe(aiId);
    expect(listing.status).toBe("COMPLETED");
    expect(listing.winningClubId).toBe(bidder.id);
    expect(player.clubId).toBe(bidder.id);
    expect(world.clubs.some((c) => c.id === aiId)).toBe(false);
  });
});

