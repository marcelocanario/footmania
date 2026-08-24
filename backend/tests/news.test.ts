import { describe, expect, it } from "vitest";
import { NEWS_SUBJECTS, formatMoney, newsVisibleTo, publishNews } from "../src/game/news";
import { generatePreseasonReport } from "../src/game/preseasonReport";
import { gameConfig } from "../src/config";
import { buildSnapshot } from "../src/services/snapshot";
import { makeClub, makeWorld } from "./helpers";
import type { Club, Player } from "../src/game/types";

function makePlayer(id: number, clubId: number, overrides: Partial<Player> = {}): Player {
  return {
    id,
    name: `Player ${id}`,
    country: "BRA",
    age: 25,
    position: 3,
    side: 0,
    skills: { gol: 10, vel: 10, tec: 10, pas: 10, des: 10, arm: 10, fin: 10 },
    overall: 50,
    potential: 60,
    energy: 100,
    salary: 1_000,
    payrollPaidThroughDay: 0,
    payrollPaidAmount: 0,
    payrollPeriodStartDay: 0,
    value: 10_000,
    releaseClause: 5_000,
    injuryDays: 0,
    contractDays: gameConfig.seasonDays * 2,
    isYouth: false,
    starter: false,
    growthAcc: 0,
    potentialAcc: 0,
    skillAcc: [0, 0, 0, 0, 0, 0, 0],
    careerGoals: 0,
    careerAssists: 0,
    seasonGoals: 0,
    seasonAssists: 0,
    yellows: 0,
    reds: 0,
    clubId,
    tacPos: -1,
    onSale: false,
    suspendedGames: 0,
    loanId: null,
    developmentProfile: { declineStartAge: 31, developmentRate: 1, developmentVolatility: 1 },
    recentMinutes: [],
    ...overrides,
  };
}

function twoClubWorld(): { world: ReturnType<typeof makeWorld>; clubA: Club; clubB: Club } {
  const clubA = makeClub({ id: 1, name: "Alpha FC", ownerUserId: 11 });
  const clubB = makeClub({ id: 2, name: "Beta FC", ownerUserId: 22 });
  const players = [makePlayer(101, 1), makePlayer(102, 1), makePlayer(201, 2)];
  return { world: makeWorld([clubA, clubB], players), clubA, clubB };
}

describe("grouped news publishing", () => {
  it("merges same-day same-subject publishes for one club into a single message", () => {
    const { world, clubA } = twoClubWorld();
    publishNews(world, {
      kind: "contract",
      subject: NEWS_SUBJECTS.contractWarning,
      recipientClubId: clubA.id,
      headline: "Contracts entering their final stretch",
      entries: [{ key: "warn:101", label: "Player 101", detail: "12 days remaining on his current deal" }],
    });
    publishNews(world, {
      kind: "contract",
      subject: NEWS_SUBJECTS.contractWarning,
      recipientClubId: clubA.id,
      headline: "Contracts entering their final stretch",
      entries: [{ key: "warn:102", label: "Player 102", detail: "20 days remaining on his current deal" }],
    });

    const warnings = world.news.filter((n) => n.subject === NEWS_SUBJECTS.contractWarning);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].entries).toHaveLength(2);
    // The dashboard message contains the grouped names and details itself.
    expect(warnings[0].text).toContain("Player 101 (12 days remaining on his current deal)");
    expect(warnings[0].text).toContain("Player 102 (20 days remaining on his current deal)");
    expect(warnings[0].seasonId).toBe(world.mp.seasonId);
    expect(world.dayIndex).toBe(0);
  });

  it("keeps different days, subjects and recipients separate", () => {
    const { world, clubA, clubB } = twoClubWorld();
    const base = { kind: "contract", subject: NEWS_SUBJECTS.contractWarning, headline: "h" };
    publishNews(world, { ...base, recipientClubId: clubA.id, entries: [{ key: "a1", label: "A1" }] });
    publishNews(world, { ...base, recipientClubId: clubB.id, entries: [{ key: "b1", label: "B1" }] });
    publishNews(world, { ...base, recipientClubId: clubA.id, subject: NEWS_SUBJECTS.contractExpiry, entries: [{ key: "a2", label: "A2" }] });
    world.dayIndex = 1;
    publishNews(world, { ...base, recipientClubId: clubA.id, entries: [{ key: "a3", label: "A3" }] });

    expect(world.news.filter((n) => n.kind === "contract")).toHaveLength(4);
  });

  it("does not merge public items across different attributions", () => {
    const { world, clubA, clubB } = twoClubWorld();
    publishNews(world, { kind: "auction", subject: NEWS_SUBJECTS.transfers, clubId: clubA.id, entries: [{ key: "t1", label: "T1" }] });
    publishNews(world, { kind: "auction", subject: NEWS_SUBJECTS.transfers, clubId: clubB.id, entries: [{ key: "t2", label: "T2" }] });
    expect(world.news).toHaveLength(2);
  });

  it("deduplicates retried entries by stable key", () => {
    const { world, clubA } = twoClubWorld();
    const input = {
      kind: "contract",
      subject: NEWS_SUBJECTS.contractExpiry,
      recipientClubId: clubA.id,
      headline: "Contract expiries",
      entries: [{ key: "expire:101", label: "Player 101", detail: "left as a free agent" }],
    };
    publishNews(world, input);
    publishNews(world, input);
    const items = world.news.filter((n) => n.subject === NEWS_SUBJECTS.contractExpiry);
    expect(items).toHaveLength(1);
    expect(items[0].entries).toHaveLength(1);
  });

  it("never merges unsubjected items (MOTDs, one-offs)", () => {
    const { world } = twoClubWorld();
    publishNews(world, { kind: "auction", text: "first notice" });
    publishNews(world, { kind: "auction", text: "second notice" });
    expect(world.news.map((n) => n.text)).toEqual(["first notice", "second notice"]);
    expect(world.news.every((n) => n.subject === undefined)).toBe(true);
  });

  it("hides club-private items from other managers in snapshots", () => {
    const { world, clubA, clubB } = twoClubWorld();
    publishNews(world, {
      kind: "contract",
      subject: NEWS_SUBJECTS.contractWarning,
      recipientClubId: clubA.id,
      headline: "Private to Alpha",
      entries: [{ key: "warn:101", label: "Player 101" }],
    });

    const seenByOwner = buildSnapshot(world, clubA.id, false).news;
    const seenByOther = buildSnapshot(world, clubB.id, false).news;
    expect(seenByOwner.some((n) => n.headline === "Private to Alpha")).toBe(true);
    expect(seenByOther.some((n) => n.headline === "Private to Alpha")).toBe(false);
    // Public attribution survives for the owner's view.
    expect(seenByOwner.find((n) => n.headline === "Private to Alpha")?.recipientClubId).toBe(clubA.id);
  });

  it("hides public news attributed to another club", () => {
    const { world, clubA, clubB } = twoClubWorld();
    publishNews(world, { kind: "auction", clubId: clubA.id, text: "Alpha completed a deal" });
    expect(buildSnapshot(world, clubA.id, false).news.some((n) => n.text === "Alpha completed a deal")).toBe(true);
    expect(buildSnapshot(world, clubB.id, false).news.some((n) => n.text === "Alpha completed a deal")).toBe(false);
  });

  it("exposes the visibility rule directly", () => {
    expect(newsVisibleTo({ recipientClubId: undefined }, 7)).toBe(true);
    expect(newsVisibleTo({ recipientClubId: 7 }, 7)).toBe(true);
    expect(newsVisibleTo({ recipientClubId: 7 }, 8)).toBe(false);
    expect(newsVisibleTo({ recipientClubId: 7 }, null)).toBe(false);
    expect(newsVisibleTo({ clubId: 7 }, 7)).toBe(true);
    expect(newsVisibleTo({ clubId: 7 }, 8)).toBe(false);
    expect(newsVisibleTo({}, 8)).toBe(true);
  });
});

describe("pre-season report", () => {
  it("writes exactly one idempotent briefing per club with the core sections", () => {
    const { world, clubA } = twoClubWorld();
    world.mp.seasonNumber = 4;
    // League membership so the report can resolve the division.
    const division = world.competitions[0];
    division.standings[clubA.id] = { clubId: clubA.id, played: 14, wins: 9, draws: 2, losses: 3, goalsFor: 20, goalsAgainst: 12, points: 29 };
    // One contract inside the warning window.
    world.players.push(makePlayer(103, clubA.id, { name: "Expiring Guy", contractDays: 15 }));

    generatePreseasonReport(world, clubA, world.mp.seasonId, gameConfig.seasonDays * gameConfig.contractWarningSeasons);
    generatePreseasonReport(world, clubA, world.mp.seasonId, gameConfig.seasonDays * gameConfig.contractWarningSeasons);

    const reports = world.news.filter((n) => n.subject === NEWS_SUBJECTS.preseasonReport);
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report.recipientClubId).toBe(clubA.id);
    expect(report.headline).toContain("Season 4 briefing");
    const labels = (report.entries ?? []).map((entry) => entry.label);
    expect(labels).toContain("Division 1");
    expect(labels).toContain("Cash");
    expect(labels).toContain("Financial cushion");
    expect(report.entries?.some((entry) => entry.label === "Expiring Guy")).toBe(true);
    expect(labels).toContain("Senior squad");
    expect(labels).toContain("Academy");
  });

  it("reports rollover flow captured during academy intake", () => {
    const { world, clubA } = twoClubWorld();
    world.mp.pendingPreseasonFlow = { [String(clubA.id)]: { promotions: 2, intake: 3, replacements: 1 } };

    generatePreseasonReport(world, clubA, world.mp.seasonId, gameConfig.seasonDays * gameConfig.contractWarningSeasons);

    const details = (world.news[0].entries ?? []).map((entry) => `${entry.label}: ${entry.detail}`).join(" | ");
    expect(details).toContain("Promotions: 2 youth players stepped up");
    expect(details).toContain("New intake: 3 new prospects");
    expect(details).toContain("Replacements: 1 senior player arrived");
  });

  it("describes a move between tiers using the archived division", () => {
    const { world, clubA } = twoClubWorld();
    const division = world.competitions[0];
    division.standings[clubA.id] = { clubId: clubA.id, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 };
    world.seasonHistory = [{
      seasonId: 0,
      seasonKey: "2025-12",
      archivedAt: 0,
      divisions: [{
        divisionId: 99,
        divisionName: "2.1",
        tier: 2,
        groupIndex: 0,
        standings: [{ clubId: clubA.id, clubName: clubA.name, played: 14, wins: 10, draws: 2, losses: 2, goalsFor: 30, goalsAgainst: 10, points: 32 }],
      }],
    }];

    generatePreseasonReport(world, clubA, world.mp.seasonId, gameConfig.seasonDays * gameConfig.contractWarningSeasons);

    expect(world.news[0].entries?.find((entry) => entry.label === "Movement")?.detail).toBe("Promoted");
  });
});

describe("shared money formatting", () => {
  it("formats compact currency consistently", () => {
    expect(formatMoney(500)).toBe("$500");
    expect(formatMoney(2_000)).toBe("$2K");
    expect(formatMoney(3_500_000)).toBe("$3.50M");
    expect(formatMoney(4_000_000)).toBe("$4M");
  });
});
