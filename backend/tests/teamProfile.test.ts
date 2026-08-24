import { describe, expect, it } from "vitest";
import { buildTeamProfile, footmaniaRankingView } from "../src/services/readService";
import { makeClub, makeWorld } from "./helpers";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Competition, Player, SeasonHistoryEntry, StandingsRow, World } from "../src/game/types";

function tableRow(clubId: number, points: number): StandingsRow {
  const wins = Math.floor(points / 3);
  const draws = points - wins * 3;
  return { clubId, played: 3, wins, draws, losses: 3 - wins - draws, goalsFor: 5, goalsAgainst: 2, points };
}

/** Archived-history rows additionally carry the frozen club-name snapshot. */
function namedRow(clubId: number, points: number, name: string): SeasonHistoryEntry["divisions"][number]["standings"][number] {
  const wins = Math.floor(points / 3);
  const draws = points - wins * 3;
  return { clubId, clubName: name, played: 3, wins, draws, losses: 3 - wins - draws, goalsFor: 5, goalsAgainst: 2, points };
}

function division(id: number, tier: number, standings: Record<number, StandingsRow>): Competition {
  return {
    id,
    kind: "division",
    name: String(tier),
    round: 0,
    stage: "group",
    seasonId: 1,
    tier,
    groupIndex: 0,
    status: "ACTIVE",
    config: { clubs: [], turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
    standings,
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
}

function historyEntry(seasonId: number, seasonKey: string, divisions: SeasonHistoryEntry["divisions"]): SeasonHistoryEntry {
  return { seasonId, seasonKey, archivedAt: seasonId * 1000, divisions };
}

function makeSquadPlayer(club: Club, id: number, overrides: Partial<Player> = {}): Player {
  return { ...generatePlayer(createRng(1), club, { id }), ...overrides };
}

function worldWith(clubs: Club[], competitions: Competition[], seasonHistory: SeasonHistoryEntry[] = [], players: Player[] = []): World {
  return makeWorld(clubs, players, { competitions, fixtures: [], seasonHistory });
}

describe("buildTeamProfile", () => {
  it("exposes public identity and results but never another club's finances or Elo", () => {
    const home = makeClub({ id: 1, name: "Alpha FC", ownerUserId: 11, cash: 77_000_000, eloRating: 1712 });
    const away = makeClub({ id: 2, name: "Beta FC", ownerUserId: null, isHuman: false, cash: 55, eloRating: 1300 });
    const comp = division(50, 1, { 1: tableRow(1, 9), 2: tableRow(2, 6) });
    const world = worldWith([home, away], [comp]);

    const profile = buildTeamProfile(world, 2)!;
    expect(profile.club).toMatchObject({ id: 2, name: "Beta FC", country: "BRA", isHuman: false, competitionState: "ACTIVE" });
    expect(profile.club.kits.home.primary).toBeTruthy();

    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('"cash"');
    expect(serialized).not.toContain('"salary"');
    expect(serialized).not.toContain("eloRating");
    expect(serialized).not.toContain("ledger");
    expect(profile.footmaniaRank).toBeNull();

    expect(buildTeamProfile(world, 999)).toBeNull();
  });

  it("exposes only the public ordinal Footmania rank for active human clubs", () => {
    const alpha = makeClub({ id: 1, name: "Alpha FC", ownerUserId: 11, eloRating: 1712 });
    const beta = makeClub({ id: 2, name: "Beta FC", ownerUserId: 12, eloRating: 1600 });
    const world = worldWith([alpha, beta], []);

    const profile = buildTeamProfile(world, alpha.id)!;
    expect(profile.footmaniaRank).toBe(1);
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain("eloRating");
    expect(serialized).not.toContain('"elo"');
  });

  it("builds a public top-ten ranking without raw ratings", () => {
    const alpha = makeClub({ id: 1, name: "Alpha FC", ownerUserId: 11, eloRating: 1712 });
    const beta = makeClub({ id: 2, name: "Beta FC", ownerUserId: 12, eloRating: 1600 });
    const world = worldWith([alpha, beta], []);

    const view = footmaniaRankingView(world, 11);
    expect(view).toMatchObject({ totalRanked: 2, viewerRank: 1 });
    expect(view.rankings.map((entry) => entry.clubId)).toEqual([1, 2]);
    expect(JSON.stringify(view)).not.toContain("elo");
  });

  it("limits the public ranking list to ten clubs", () => {
    const clubs = Array.from({ length: 12 }, (_, index) => makeClub({
      id: index + 1,
      ownerUserId: index + 1,
      name: `Club ${index + 1}`,
      eloRating: 1800 - index,
    }));
    const view = footmaniaRankingView(worldWith(clubs, []));
    expect(view.totalRanked).toBe(12);
    expect(view.rankings).toHaveLength(10);
    expect(view.rankings.at(-1)?.rank).toBe(10);
  });

  it("summarises the current division snapshot with position and filtered fixtures", () => {
    const alpha = makeClub({ id: 1, name: "Alpha FC", ownerUserId: 11 });
    const beta = makeClub({ id: 2, name: "Beta FC", ownerUserId: 12 });
    const outsider = makeClub({ id: 3, name: "Gamma FC", ownerUserId: 13 });
    const comp = division(50, 1, { 1: tableRow(1, 12), 2: tableRow(2, 9) });
    const world = worldWith([alpha, beta, outsider], [comp]);
    world.fixtures.push(
      { id: 601, competitionId: 50, round: 3, homeClubId: 1, awayClubId: 2, dayIndex: 10, played: false },
      { id: 602, competitionId: 51, round: 3, homeClubId: 1, awayClubId: 3, dayIndex: 11, played: false },
      { id: 603, competitionId: 50, round: 4, homeClubId: 2, awayClubId: 1, dayIndex: 14, played: true },
    );

    const profile = buildTeamProfile(world, 1)!;
    expect(profile.season).toMatchObject({
      division: { id: 50, tier: 1, groupIndex: 0 },
      position: 1,
      points: 12,
    });
    expect(profile.standings.map((r) => r.clubId)).toEqual([1, 2]);
    // Only the viewed club's own division fixtures come back.
    expect(profile.fixtures.map((f) => f.id).sort()).toEqual([601, 603]);
    expect(profile.history).toEqual([]);
  });

  it("lists a minimal squad digest and aggregates total value (players + cash)", () => {
    const club = makeClub({ id: 1, name: "Alpha FC", ownerUserId: 11, cash: 1_000_000 });
    const rival = makeClub({ id: 2, name: "Beta FC", ownerUserId: null, isHuman: false });
    // Ordering rule: not-youth first, then pitch position, then name.
    const gk = makeSquadPlayer(club, 101, { clubId: 1, value: 4_500_000, overall: 80, isYouth: false, position: 0, name: "Ed", nickname: "The Wall" });
    const forward = makeSquadPlayer(club, 102, { clubId: 1, value: 500_000, overall: 55, isYouth: false, position: 3, name: "Carl" });
    const mid = makeSquadPlayer(club, 103, { clubId: 1, value: 600_000, overall: 70, isYouth: false, position: 2, name: "Bob" });
    const youthStriker = makeSquadPlayer(club, 104, { clubId: 1, value: 100_000, overall: 90, isYouth: true, position: 3, name: "Amy" });
    const rivalsPlayer = makeSquadPlayer(rival, 201, { clubId: 2, value: 9_999_999, overall: 90 });
    const comp = division(50, 1, { 1: tableRow(1, 9), 2: tableRow(2, 6) });
    const world = worldWith([club, rival], [comp], [], [gk, forward, mid, youthStriker, rivalsPlayer]);

    const profile = buildTeamProfile(world, 1)!;
    expect(profile.players.map((p) => p.id)).toEqual([101, 103, 102, 104]);
    // Raw name plus the raw nickname; quoting is the client's concern.
    expect(profile.players[0]).toMatchObject({ name: "Ed", nickname: "The Wall", overall: 80, isYouth: false });
    // Youth players land last even with a higher overall.
    expect(profile.players[3]).toMatchObject({ id: 104, isYouth: true, overall: 90 });
    // Total value counts only this club's squad plus its own cash.
    expect(profile.totalValue).toBe(4_500_000 + 600_000 + 500_000 + 100_000 + 1_000_000);
    // Per-player finances never leave the server.
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('"salary"');
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"contractDays"');
  });

  it("reports no season for a club outside the current pyramid", () => {
    const provisional = makeClub({ id: 1, name: "Newcomer FC", ownerUserId: 21, competitionState: "PROVISIONAL" });
    const world = worldWith([provisional], []);
    const profile = buildTeamProfile(world, 1)!;
    expect(profile.season).toBeNull();
    expect(profile.standings).toEqual([]);
    expect(profile.fixtures).toEqual([]);
  });

  it("derives champion/promoted/relegated movement from consecutive recorded tiers", () => {
    const climber = makeClub({ id: 1, name: "Climber FC", ownerUserId: 31 });
    const stayer = makeClub({ id: 2, name: "Stayer FC", ownerUserId: 32 });
    const dropper = makeClub({ id: 3, name: "Dropper FC", ownerUserId: 33 });
    const filler = makeClub({ id: 4, name: "Filler FC", ownerUserId: null, isHuman: false });

    const season1 = historyEntry(1, "2026-01", [
      { divisionId: 10, divisionName: "1", tier: 1, groupIndex: 0, standings: [namedRow(2, 12, "Stayer FC"), namedRow(3, 6, "Dropper FC")] },
      { divisionId: 20, divisionName: "2A", tier: 2, groupIndex: 0, standings: [namedRow(1, 15, "Climber FC"), namedRow(4, 9, "Filler FC")] },
    ]);
    const season2 = historyEntry(2, "2026-02", [
      { divisionId: 11, divisionName: "1", tier: 1, groupIndex: 0, standings: [namedRow(1, 14, "Climber FC"), namedRow(2, 11, "Stayer FC")] },
      { divisionId: 21, divisionName: "2A", tier: 2, groupIndex: 0, standings: [namedRow(3, 13, "Dropper FC"), namedRow(4, 7, "Filler FC")] },
    ]);
    const world = worldWith([climber, stayer, dropper, filler], [], [season1, season2]);

    const climberRows = buildTeamProfile(world, 1)!.history;
    expect(climberRows).toHaveLength(2);
    expect(climberRows[0]).toMatchObject({ seasonKey: "2026-01", tier: 2, position: 1, champion: true, promoted: false, relegated: false });
    expect(climberRows[1]).toMatchObject({ seasonKey: "2026-02", tier: 1, position: 1, champion: true, promoted: true, relegated: false });

    const stayerRows = buildTeamProfile(world, 2)!.history;
    expect(stayerRows[0]).toMatchObject({ champion: true, promoted: false, relegated: false });
    expect(stayerRows[1]).toMatchObject({ champion: false, promoted: false, relegated: false });

    const dropperRows = buildTeamProfile(world, 3)!.history;
    expect(dropperRows[0]).toMatchObject({ champion: false, promoted: false, relegated: false });
    expect(dropperRows[1]).toMatchObject({ tier: 2, champion: true, promoted: false, relegated: true });

    // History is oldest-first for timeline rendering.
    expect(climberRows.map((r) => r.seasonKey)).toEqual(["2026-01", "2026-02"]);
  });

  it("counts trophies from the club cabinet", () => {
    const club = makeClub({ id: 1, trophies: { "1": 2 } });
    const world = worldWith([club], []);
    expect(buildTeamProfile(world, 1)!.trophies).toEqual({ "1": 2 });
  });
});
