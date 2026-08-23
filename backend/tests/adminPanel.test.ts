import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { generatePlayer } from "../src/game/player";
import { emptyStandingsRow } from "../src/game/league";
import { divisionAnalytics } from "../src/game/adminAnalytics";
import { divisionMean } from "../src/game/playerGeneration";
import { suggestedModerationClubName } from "../src/game/multiplayer";
import { buildSnapshot } from "../src/services/snapshot";
import type { Club, Competition, Player, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

function makePlayer(clubId: number | null, overrides: Partial<Player> = {}): Player {
  const club = makeClub();
  return { ...generatePlayer(createRng(7), club, { id: 1 }), clubId, ...overrides };
}

function makeDivision(id: number, tier: number, groupIndex: number, clubIds: number[], overrides: Partial<Competition> = {}): Competition {
  const standings: Competition["standings"] = {};
  for (const clubId of clubIds) standings[clubId] = emptyStandingsRow(clubId);
  return {
    id,
    kind: "division",
    name: tier === 1 ? "1" : `${tier}.${groupIndex + 1}`,
    round: 0,
    stage: "group",
    seasonId: 1,
    tier,
    groupIndex,
    status: "ACTIVE",
    config: { clubs: clubIds, turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
    standings,
    groupStandings: [],
    winners: [],
    knockouts: [],
    ...overrides,
  };
}

describe("admin world analytics", () => {
  it("projects each division with the canonical divisionMean curve", () => {
    const clubs = [makeClub({ id: 1 }), makeClub({ id: 2 })];
    const players = [
      makePlayer(1, { overall: 70 }),
      makePlayer(1, { overall: 80 }),
      makePlayer(2, { overall: 60 }),
    ];
    const divisions = [makeDivision(901, 1, 0, [1]), makeDivision(902, 2, 0, [2])];
    const world = makeWorld(clubs, players, { competitions: divisions, fixtures: [] });

    const analytics = divisionAnalytics(world);
    // Pyramid depth is the highest active tier.
    expect(analytics.totalDivisions).toBe(2);
    expect(analytics.divisions).toHaveLength(2);
    for (const row of analytics.divisions) {
      expect(row.projectedAvgOverall).toBeCloseTo(Math.round(divisionMean(row.tier, 2) * 100) / 100, 6);
    }
    // Tier 1 projects strictly stronger than tier 2 on the canonical curve.
    expect(analytics.divisions[0].projectedAvgOverall).toBeGreaterThan(analytics.divisions[1].projectedAvgOverall);
  });

  it("averages senior overalls only and derives the delta against the projection", () => {
    const clubs = [makeClub({ id: 1, ownerUserId: 11 }), makeClub({ id: 2, ownerUserId: 12 })];
    const players = [
      makePlayer(1, { overall: 70 }),
      makePlayer(1, { overall: 80 }),
      // A youth prodigy must not skew the senior average…
      makePlayer(1, { overall: 99, isYouth: true }),
      // …and a free agent / academy player without a club is invisible.
      makePlayer(null, { overall: 50 }),
      makePlayer(2, { overall: 64 }),
      makePlayer(2, { overall: 66 }),
    ];
    const divisions = [makeDivision(901, 1, 0, [1, 2])];
    const world = makeWorld(clubs, players, { competitions: divisions, fixtures: [] });

    const analytics = divisionAnalytics(world);
    expect(analytics.summary.clubCount).toBe(2);

    const rowsByClubCount = analytics.divisions;
    expect(rowsByClubCount).toHaveLength(1);
    const row = rowsByClubCount[0];
    // Seniors in the division: 70, 80, 64, 66 → mean 70.
    expect(row.realAvgOverall).toBe(70);
    expect(row.deltaOverall).toBeCloseTo(Math.round((70 - row.projectedAvgOverall) * 100) / 100, 6);
  });

  it("counts financial distress only for active human clubs", () => {
    const distressedHuman = makeClub({ id: 1, ownerUserId: 21, competitionState: "ACTIVE", cash: -100 });
    const dormantHuman = makeClub({ id: 2, ownerUserId: 22, competitionState: "DORMANT", cash: -100 });
    const distressedAi = makeClub({ id: 3, ownerUserId: null, competitionState: "ACTIVE", cash: -100 });
    const healthyHuman = makeClub({ id: 4, ownerUserId: 23, competitionState: "ACTIVE", cash: 1_000_000 });
    const clubs = [distressedHuman, dormantHuman, distressedAi, healthyHuman];
    const players = clubs.map((c) => makePlayer(c.id, { overall: 60 }));
    const divisions = [makeDivision(901, 1, 0, clubs.map((c) => c.id))];
    const world = makeWorld(clubs, players, { competitions: divisions, fixtures: [] });

    const analytics = divisionAnalytics(world);
    expect(analytics.summary.clubsInFinancialDistress).toBe(1);
    expect(analytics.divisions[0].clubsInFinancialDistress).toBe(1);
  });

  it("reports null real averages for an empty division", () => {
    const divisions = [makeDivision(901, 1, 0, [])];
    const world = makeWorld([], [], { competitions: divisions, fixtures: [] });
    const analytics = divisionAnalytics(world);
    expect(analytics.divisions[0].realAvgOverall).toBeNull();
    expect(analytics.divisions[0].deltaOverall).toBeNull();
    expect(analytics.summary.realAvgOverall).toBeNull();
  });

  it("weights the world summary by squad size across divisions", () => {
    const clubs = [makeClub({ id: 1 }), makeClub({ id: 2 })];
    // Division A (tier 1) has one 80-OVR senior; division B (tier 2) has three
    // 60-OVR seniors → player-weighted world mean = (80 + 180) / 4 = 65.
    const players = [
      makePlayer(1, { overall: 80 }),
      makePlayer(2, { overall: 60 }),
      makePlayer(2, { overall: 60 }),
      makePlayer(2, { overall: 60 }),
    ];
    const divisions = [makeDivision(901, 1, 0, [1]), makeDivision(902, 2, 0, [2])];
    const world = makeWorld(clubs, players, { competitions: divisions, fixtures: [] });

    const analytics = divisionAnalytics(world);
    expect(analytics.summary.realAvgOverall).toBe(65);
  });
});

describe("snapshot MOTD pinning", () => {
  function newsOf(world: World): string[] {
    return buildSnapshot(world, world.clubs[0]?.id ?? 1, false).news.map((n) => n.text);
  }

  it("pins admin announcements ahead of newer chronological feed items", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    world.news.push(
      { dayIndex: 1, text: "old event", kind: "mp" },
      { dayIndex: 2, text: "ADMIN ANNOUNCEMENT", kind: "motd" },
      { dayIndex: 3, text: "newer match result", kind: "mp" },
      { dayIndex: 3, text: "another result", kind: "mp" },
    );

    const texts = newsOf(world);
    expect(texts[0]).toBe("ADMIN ANNOUNCEMENT");
    // The rest stays newest-first below the pin.
    expect(texts.slice(1)).toEqual(["another result", "newer match result", "old event"]);
  });

  it("keeps the announcement pinned even when the feed window scrolls past its day", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    world.news.push({ dayIndex: 1, text: "ADMIN ANNOUNCEMENT", kind: "motd" });
    for (let day = 40; day <= 70; day++) world.news.push({ dayIndex: day, text: `result ${day}`, kind: "mp" });

    const snapshot = buildSnapshot(world, club.id, false);
    // The default window keeps the last 30 items; the motd is hoisted anyway.
    expect(snapshot.news.map((n) => n.text)).toContain("ADMIN ANNOUNCEMENT");
    expect(snapshot.news[0].text).toBe("ADMIN ANNOUNCEMENT");
  });

  it("leaves a feed without announcements untouched", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    world.news.push(
      { dayIndex: 5, text: "first", kind: "mp" },
      { dayIndex: 6, text: "second", kind: "contract" },
    );
    expect(newsOf(world)).toEqual(["second", "first"]);
  });
});

describe("moderation name suggestions", () => {
  it("is deterministic per attempt", () => {
    expect(suggestedModerationClubName(0)).toBe(suggestedModerationClubName(0));
    expect(suggestedModerationClubName(7)).toBe(suggestedModerationClubName(7));
  });

  it("varies across attempts (rerolls give different suggestions)", () => {
    const values = new Set(Array.from({ length: 8 }, (_, attempt) => suggestedModerationClubName(attempt)));
    // Cities are drawn from a fixed pool, so individual collisions are fine;
    // eight attempts must not all land on the same name.
    expect(values.size).toBeGreaterThan(1);
  });

  it("uses the filler-AI naming pattern so resets fit the pyramid", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(suggestedModerationClubName(attempt)).toMatch(/^[A-Za-z ]+ FC$/);
    }
  });
});
