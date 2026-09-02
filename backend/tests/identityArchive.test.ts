import { describe, expect, it } from "vitest";
import { archiveRowForClub, archiveRowsFromWorld, resolveArchiveRow, applyArchivedIdentity } from "../src/game/identityArchive";
import { replaceActiveClubWithAi, regenerateAiIdentity, removeNonActiveClub } from "../src/game/aiTakeover";
import { startLiveMatch } from "../src/game/world";
import { makeClub, makeWorld } from "./helpers";
import type { Club, Competition, Fixture, Player } from "../src/game/types";

function humanClub(overrides: Partial<Club> = {}): Club {
  return makeClub({
    id: 7,
    ownerUserId: 3,
    isHuman: true,
    name: "Rio Grande United",
    shortName: "RG United",
    country: "BRA",
    stadiumName: "Maracanazo Arena",
    coachName: "Coach Pinto",
    kits: {
      home: { primary: "#123456", secondary: "#ffffff", accent: "#000000", numberColor: "#ffffff", pattern: "stripes" },
      away: { primary: "#ffffff", secondary: "#123456", accent: "#000000", numberColor: "#123456", pattern: "solid" },
      gk: { primary: "#00ff00", secondary: "#000000", accent: "#000000", numberColor: "#ffffff", pattern: "solid" },
    },
    primaryColor: "#123456",
    secondaryColor: "#ffffff",
    logoVariant: 3,
    customLogo: { mime: "image/png", data: "AAAA", status: "ACTIVE" },
    preferredHours: [18, 19, 20, 21],
    friendGroupingOptIn: false,
    ...overrides,
  });
}

function player(id: number, clubId: number, overrides: Partial<Player> = {}): Player {
  return {
    id,
    name: `P${id}`,
    country: "BRA",
    age: 24,
    position: "GK",

    skills: { gol: 60, pace: 60, tec: 60, pas: 60, des: 60, playmaking: 60, fin: 60 },
    overall: 70,
    energy: 100,
    salary: 1000,
    payrollPaidThroughDay: 0,
    payrollPaidAmount: 0,
    payrollPeriodStartDay: 0,
    value: 10_000,
    releaseClause: 20_000,
    injuryDays: 0,
    contractDays: 300,
    isYouth: false,
    starter: false,
    careerGrowthConsumed: 0,
    careerDeclineConsumed: 0,
    skillAcc: [0, 0, 0, 0, 0, 0, 0],
    careerGoals: 0,
    careerAssists: 0,
    seasonGoals: 0,
    seasonAssists: 0,
    yellows: 0,
    reds: 0,
    clubId,
    onSale: false,
    suspendedGames: 0,
    loanId: null,
    careerProfile: { growthPotential: 5, growthSpeed: 0.5, peakAge: 29, declinePotential: 0.4, declineSpeed: 0.5 },
    recentMinutes: [],
    ...overrides,
  };
}

describe("identityArchive", () => {
  it("captures every human club identity field and skips AI clubs", () => {
    const world = makeWorld([humanClub(), makeClub({ id: 8, ownerUserId: null, isHuman: false })], []);
    const rows = archiveRowsFromWorld(world);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.userId).toBe(3);
    expect(row.name).toBe("Rio Grande United");
    expect(row.shortName).toBe("RG United");
    expect(row.country).toBe("BRA");
    expect(row.stadiumName).toBe("Maracanazo Arena");
    expect(row.coachName).toBe("Coach Pinto");
    expect(row.primaryColor).toBe("#123456");
    expect(row.secondaryColor).toBe("#ffffff");
    expect(row.logoVariant).toBe(3);
    expect(row.customLogoData).toBe("AAAA");
    expect(row.preferredHoursJson).toBe("[18,19,20,21]");
    expect(row.friendGroupingOptIn).toBe(false);
    expect(JSON.parse(row.kitJson!)).toMatchObject({ home: { primary: "#123456" } });
  });

  it("archives ACTIVE and DORMANT human clubs (not PROVISIONAL/AI)", () => {
    const world = makeWorld(
      [
        humanClub({ id: 1, ownerUserId: 1 }),
        humanClub({ id: 2, ownerUserId: 2, competitionState: "DORMANT" }),
        humanClub({ id: 3, ownerUserId: 3, competitionState: "PROVISIONAL" }),
        makeClub({ id: 4, ownerUserId: null, isHuman: false }),
      ],
      [],
    );
    const rows = archiveRowsFromWorld(world);
    expect(rows.map((r) => r.userId).sort()).toEqual([1, 2]);
  });

  it("round-trips a captured row through resolve + apply", () => {
    const world = makeWorld([humanClub()], []);
    const rows = archiveRowsFromWorld(world);
    const resolved = resolveArchiveRow({
      name: rows[0].name,
      shortName: rows[0].shortName,
      country: rows[0].country,
      stadiumName: rows[0].stadiumName,
      coachName: rows[0].coachName,
      kitJson: rows[0].kitJson ?? null,
      primaryColor: rows[0].primaryColor,
      secondaryColor: rows[0].secondaryColor,
      logoVariant: rows[0].logoVariant ?? 0,
      customLogoMime: rows[0].customLogoMime ?? null,
      customLogoData: rows[0].customLogoData ?? null,
      customLogoStatus: rows[0].customLogoStatus ?? null,
      preferredHoursJson: rows[0].preferredHoursJson ?? null,
      friendGroupingOptIn: rows[0].friendGroupingOptIn ?? true,
    });
    const applied = applyArchivedIdentity(resolved, {
      userId: 3,
      clubName: "Wizard Name",
      country: "ARG",
      primaryColor: "#000000",
      secondaryColor: "#ffffff",
      stadiumName: "Wizard Stadium",
      coachName: "Wizard Coach",
      preferredHours: [1, 2],
    });
    expect(applied.clubName).toBe("Rio Grande United");
    expect(applied.country).toBe("BRA");
    expect(applied.stadiumName).toBe("Maracanazo Arena");
    expect(applied.coachName).toBe("Coach Pinto");
    expect(applied.primaryColor).toBe("#123456");
    expect(applied.kits?.home.primary).toBe("#123456");
    expect(applied.preferredHours).toEqual([18, 19, 20, 21]);
    expect(applied.friendGroupingOptIn).toBe(false);
  });

  it("archives a club without kits/logo as nulls", () => {
    const world = makeWorld([humanClub({ kits: null, customLogo: null })], []);
    const rows = archiveRowsFromWorld(world);
    expect(rows[0].kitJson).toBeNull();
    expect(rows[0].customLogoData).toBeNull();
    const resolved = resolveArchiveRow({
      name: rows[0].name,
      shortName: rows[0].shortName,
      country: rows[0].country,
      stadiumName: rows[0].stadiumName,
      coachName: rows[0].coachName,
      kitJson: rows[0].kitJson ?? null,
      primaryColor: rows[0].primaryColor,
      secondaryColor: rows[0].secondaryColor,
      logoVariant: rows[0].logoVariant ?? 0,
      customLogoMime: rows[0].customLogoMime ?? null,
      customLogoData: rows[0].customLogoData ?? null,
      customLogoStatus: rows[0].customLogoStatus ?? null,
      preferredHoursJson: rows[0].preferredHoursJson ?? null,
      friendGroupingOptIn: rows[0].friendGroupingOptIn ?? true,
    });
    expect(resolved.kits).toBeNull();
    expect(resolved.customLogo).toBeNull();
  });
});

describe("aiTakeover", () => {
  it("converts an ACTIVE club to a deterministic AI filler in place", () => {
    const players = Array.from({ length: 20 }, (_, i) => player(100 + i, 7));
    const club = humanClub({ highestDivision: 1 });
    const world = makeWorld([club], players);
    // The club sits in a division with standings + fixtures referencing it.
    world.mp.seasonId = 1;
    // Division at tier 2: the converted AI team keeps the current tier, not
    // the human-era highest-division milestone.
    world.competitions.push({
      id: 901,
      kind: "division",
      name: "2.1",
      round: 0,
      stage: "group",
      seasonId: 1,
      tier: 2,
      groupIndex: 0,
      status: "ACTIVE",
      config: { clubs: [], turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
      standings: { [club.id]: { clubId: club.id, played: 4, wins: 2, draws: 1, losses: 1, goalsFor: 5, goalsAgainst: 3, points: 7 } },
      groupStandings: [],
      winners: [],
      knockouts: [],
    });
    const outcome = replaceActiveClubWithAi(world, club, 1000);

    expect(outcome.converted).toBe(true);
    expect(club.ownerUserId).toBeNull();
    expect(club.isHuman).toBe(false);
    expect(club.name).toMatch(/ FC$/);
    expect(club.name).not.toBe("Rio Grande United");
    expect(club.customLogo).toBeNull();
    expect(club.cash).toBe(0);
    expect(club.ledger).toEqual({ income: [], expense: [] });
    expect(club.trophies).toEqual({});
    expect(club.savedLineup).toBeNull();
    // Automation presets live outside the World object (services/
    // automationPresetService.ts, plan §11 Part 4) — clearing them on
    // takeover is the caller's (routes/admin.ts) responsibility, not this
    // pure domain function's; see integration coverage instead.
    expect(club.captainId).toBeNull();
    expect(club.penaltyTakerId).toBeNull();
    expect(club.competitionState).toBe("ACTIVE");
    // The current tier is kept, the human-era milestone is not inherited.
    expect(club.highestDivision).toBe(2);
    expect(club.kits).toBeDefined();
    expect(club.primaryColor).toBe(club.kits!.home.primary);
    expect(club.secondaryColor).toBe(club.kits!.home.secondary);
    // The human squad was replaced by a fresh static filler roster.
    expect(world.players.every((p) => p.clubId !== 7)).toBe(false);
    expect(world.players.filter((p) => p.clubId === 7).length).toBeGreaterThan(0);
    expect(world.players.filter((p) => p.clubId === 7).length).not.toBe(20);
    // Deterministic identity: same club id -> same name/kits on retry.
    const club2 = humanClub();
    const world2 = makeWorld([club2], []);
    replaceActiveClubWithAi(world2, club2, 2000);
    expect(club2.name).toBe(club.name);
    expect(club2.kits).toEqual(club.kits);
  });

  it("force-finishes a live match before converting the club", () => {
    const players = [
      ...Array.from({ length: 20 }, (_, i) => player(100 + i, 7)),
      ...Array.from({ length: 20 }, (_, i) => player(300 + i, 8)),
    ];
    const club = humanClub();
    const away = makeClub({ id: 8, ownerUserId: null, isHuman: false });
    const world = makeWorld([club, away], players);
    world.mp.seasonId = 1;
    const division: Competition = {
      id: 901,
      kind: "division",
      name: "1",
      round: 0,
      stage: "group",
      seasonId: 1,
      tier: 1,
      groupIndex: 0,
      status: "ACTIVE",
      config: { clubs: [], turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
      standings: { [club.id]: { clubId: club.id, played: 4, wins: 2, draws: 1, losses: 1, goalsFor: 5, goalsAgainst: 3, points: 7 } },
      groupStandings: [],
      winners: [],
      knockouts: [],
    };
    world.competitions.push(division);
    const fixture: Fixture = { id: 501, competitionId: division.id, round: 1, homeClubId: 7, awayClubId: 8, dayIndex: 1, played: false, kickoffAt: Date.now() - 60_000 };
    world.fixtures.push(fixture);
    // Kick the live match off mid-first-half, then immediately convert.
    const started = startLiveMatch(world, fixture, Date.now() - 60_000);
    expect(started).not.toBeNull();
    const st = world.liveMatches.find((m) => m.homeClubId === 7);
    expect(st).toBeDefined();

    const outcome = replaceActiveClubWithAi(world, club, Date.now());

    // The live match was force-finished (no live state may survive the squad
    // swap) and the fixture is now played.
    expect(outcome.converted).toBe(true);
    expect(world.liveMatches.some((m) => m.homeClubId === 7 || m.awayClubId === 7)).toBe(false);
    expect(world.matches.some((m) => m.homeClubId === 7)).toBe(true);
    expect(fixture.played).toBe(true);
    // The away side's players are untouched.
    expect(world.players.some((p) => p.clubId === 8)).toBe(true);
    // No dangling live-match anchor.
    expect(club.liveMatchAt).toBeNull();
  });

  it("removes a NON-active club entirely including queue/membership rows", () => {
    const club = humanClub({ competitionState: "DORMANT", ownerUserId: 5 });
    const players = Array.from({ length: 5 }, (_, i) => player(200 + i, club.id));
    const world = makeWorld([club, makeClub({ id: 9, ownerUserId: null, isHuman: false })], players);
    world.mpQueue = [{ clubId: club.id, source: "NEW_CLUB", queuedAt: 1, preferredSeasonId: 1 }];
    world.mpMemberships = [{ divisionId: 1, clubId: club.id, slotNumber: 1, isFillerAI: false, replacedClubId: null, joinedAt: 1 }];

    const outcome = removeNonActiveClub(world, club, 1000);
    expect(outcome.converted).toBe(false);
    expect(world.clubs.some((c) => c.id === club.id)).toBe(false);
    expect(world.players.some((p) => p.clubId === club.id)).toBe(false);
    expect(world.mpQueue.some((q) => q.clubId === club.id)).toBe(false);
    expect(world.mpMemberships.some((m) => m.clubId === club.id)).toBe(false);
  });

  it("regenerateAiIdentity is deterministic per club id", () => {
    const a = humanClub();
    const b = humanClub();
    regenerateAiIdentity(makeWorld([], []), a);
    regenerateAiIdentity(makeWorld([], []), b);
    expect(a.name).toBe(b.name);
    expect(a.kits).toEqual(b.kits);
    expect(a.coachName).toBe(b.coachName);
  });
});
