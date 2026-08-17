import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateWorld, assignHumanClub } from "../src/game/worldgen";
import { advance, finalizeLiveMatch } from "../src/game/world";
import { buildLineup } from "../src/game/club";
import { tickLiveMatch } from "../src/game/match";
import { generateName, hasNamePool } from "../src/game/names";
import { createRng } from "../src/game/rng";
import { parseGameConfig } from "../src/config";
import { LEAGUE_PRIZES, TV_POSITION_BONUS } from "../src/game/constants";
import { sortedStandings } from "../src/game/league";
import type { World } from "../src/game/types";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "assets", "namepools");

function poolLines(kind: "names" | "surnames", code: string): Set<string> {
  const lines = readFileSync(join(assets, kind, `${code}.txt`), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes(".") && !/\d/.test(l));
  return new Set(lines);
}

const NAME_STOPWORDS = new Set(["de", "da", "do", "dos", "das", "van", "von", "del", "della", "di", "el", "al", "ibn", "bin", "o'", "mc", "mac"]);

function nameMatchesPool(name: string, names: Set<string>, surnames: Set<string>): boolean {
  if (names.has(name) || surnames.has(name)) return true;
  const words = name.split(/\s+/);
  return words.every((w) => names.has(w) || surnames.has(w) || NAME_STOPWORDS.has(w.toLowerCase()));
}

function finishLiveMatch(world: World, guard = 10): ReturnType<typeof finalizeLiveMatch> {
  let result: ReturnType<typeof finalizeLiveMatch> | undefined;
  let g = 0;
  while (world.liveMatch && g++ < guard) {
    const st = world.liveMatch;
    const home = world.clubs.find((c) => c.id === st.homeClubId)!;
    const away = world.clubs.find((c) => c.id === st.awayClubId)!;
    tickLiveMatch(world.rng, home, away, world.players, st, 200, { ignoreHalfTime: true });
    result = finalizeLiveMatch(world);
  }
  return result ?? { dayIndex: 0, dateLabel: "", playedMatches: [], news: [], events: [], humanMatch: undefined, matchPending: false, seasonEnded: false };
}

describe("worldgen", () => {
  it("generates a single-league 8-club world", () => {
    const world = generateWorld(12345);
    expect(world.clubs.length).toBe(8);
    expect(world.players.length).toBeGreaterThan(150);
    expect(world.competitions.length).toBe(1);
    const league = world.competitions[0];
    expect(league.kind).toBe("league");
    expect(league.config.clubs.length).toBe(8);
    expect(Object.keys(league.standings).length).toBe(8);
    expect(world.fixtures.length).toBe(56);
    expect(world.fixtures.filter((f) => f.competitionId === league.id).length).toBe(56);
    const matchDays = new Set(world.fixtures.map((f) => f.dayIndex));
    expect(matchDays.size).toBe(14);
    for (const club of world.clubs) {
      expect(club.country.length).toBe(3);
    }
  });

  it("every club can build a legal 11", () => {
    const world = generateWorld(999);
    for (const club of world.clubs) {
      const lineup = buildLineup(club, world.players);
      expect(lineup?.starters.length, `${club.name} starters`).toBe(11);
    }
  });

  it("advances into a live match within 2 game-days and finalizes it", () => {
    const world = generateWorld(4242);
    world.humanClubId = world.clubs[0].id;
    world.clubs[0].isHuman = true;
    let res = advance(world);
    while (!res.matchPending && !res.seasonEnded && world.dayIndex < 5) {
      res = advance(world);
    }
    expect(res.matchPending || res.seasonEnded).toBe(true);
    finishLiveMatch(world);
    const played = world.matches.length;
    expect(played).toBeGreaterThan(0);
    const playedFixtureCount = world.fixtures.filter((f) => f.played).length;
    expect(playedFixtureCount).toBe(played);
  });

  it("runs a full season to rollover: year increments, all players age +1, summary is league-only", () => {
    const world = generateWorld(4242);
    world.humanClubId = world.clubs[0].id;
    world.clubs[0].isHuman = true;
    const agesBefore = new Map(world.players.map((p) => [p.id, p.age]));
    let guard = 0;
    let seasonEnded = false;
    while (!seasonEnded && guard++ < 500) {
      const res = advance(world);
      if (res.matchPending) {
        const fin = finishLiveMatch(world);
        if (fin.seasonEnded) seasonEnded = true;
      }
      if (res.seasonEnded) seasonEnded = true;
    }
    expect(seasonEnded).toBe(true);
    expect(world.year).toBe(2);
    expect(world.dayIndex).toBe(0);
    for (const p of world.players) {
      const before = agesBefore.get(p.id);
      if (before !== undefined) expect(p.age).toBe(before + 1);
    }
    expect(world.seasonSummary).not.toBeNull();
    expect(Object.keys(world.seasonSummary!).sort()).toEqual(["leagueChampionId", "leagueRunnerUpId"]);
  });

  it("economy sim: no club goes bankrupt, payroll ≈ seasonal wage bill, prizes land", () => {
    const world = generateWorld(4242);
    world.humanClubId = world.clubs[0].id;
    world.clubs[0].isHuman = true;
    const wageBills = new Map(world.clubs.map((c) => [c.id, world.players.filter((p) => p.clubId === c.id).reduce((s, p) => s + p.salary, 0)]));
    let guard = 0;
    let seasonEnded = false;
    while (!seasonEnded && guard++ < 500) {
      const res = advance(world);
      if (res.matchPending) {
        const fin = finishLiveMatch(world);
        if (fin.seasonEnded) seasonEnded = true;
      }
      if (res.seasonEnded) seasonEnded = true;
      for (const club of world.clubs) {
        expect(club.cash, `${club.name} cash on day ${world.dayIndex}`).toBeGreaterThanOrEqual(0);
      }
    }
    expect(seasonEnded).toBe(true);
    for (const club of world.clubs) {
      const paid = club.ledger.expense.filter((e) => e.code === 4).reduce((s, e) => s + e.amount, 0);
      const bill = wageBills.get(club.id) ?? 0;
      if (bill > 0) {
        expect(paid).toBeGreaterThanOrEqual(bill * 0.6);
        // Transfers and rollover squad top-ups can add players during the
        // season, so the initial roster bill is only a lower-bound baseline.
        expect(paid).toBeLessThanOrEqual(bill * 1.5);
      }
    }
    const league = world.competitions.find((c) => c.kind === "league")!;
    const champion = world.seasonSummary!.leagueChampionId!;
    const champ = world.clubs.find((c) => c.id === champion)!;
    const prizeEntries = champ.ledger.income.filter((e) => e.code === 5);
    expect(prizeEntries.reduce((s, e) => s + e.amount, 0)).toBeGreaterThanOrEqual(LEAGUE_PRIZES[0]);
    const tvEntries = champ.ledger.income.filter((e) => e.code === 11);
    expect(tvEntries.reduce((s, e) => s + e.amount, 0)).toBeGreaterThanOrEqual(TV_POSITION_BONUS[0]);
    expect(league.config.clubs.length).toBe(8);
  });
});

describe("game config validation", () => {
  const economyFields = {
    playerValueBase: 9000,
    playerValueOverallReference: 50,
    playerValueOverallExponent: 3.5,
    playerValueMultiplier: 1,
    playerValueAgeCurve: { 16: 0.65, 22: 1.1, 30: 0.9 },
    playerValueContractNeutralSeasons: 3,
    playerValueContractWeight: 0.05,
    playerValueContractMinMultiplier: 0.9,
    playerValueContractMaxMultiplier: 1.1,
    salaryBase: 2500,
    salaryOverallReference: 50,
    salaryOverallExponent: 2.5,
    salaryMultiplier: 1,
    salaryAgeCurve: { 16: 0.5, 22: 1.1, 30: 0.95 },
    salaryFloor: 500,
    academySalaryMultiplier: 0.1,
    maxContractSeasons: 5,
    renewalMinRaise: 0.02,
    renewalSkillRaiseWeight: 0.08,
    renewalSkillExponent: 1.6,
    renewalMaxRaise: 0.15,
    renewalAgeCurve: { 20: 1.3, 28: 1 },
    releaseClauseRemainingValuePct: 0.5,
  };

  it("accepts the derived league math from the shipped config", () => {
    const cfg = parseGameConfig({
      seasonDays: 30,
      league: { teams: 8, turns: 2, startDay: 1, matchIntervalDays: 2 },
      payrollIntervalDays: 7,
      weeklyIntervalDays: 7,
      transferIntervalDays: 1,
      auctionDurationDays: 7,
      loanDurationSeasons: 1,
      stadiumUpgradeDays: 15,
      contractWarningSeasons: 2,
      humanMatchDurationMinutes: 10,
      ...economyFields,
    });
    expect(cfg.league.teams).toBe(8);
  });

  it("rejects a calendar where lastMatchDay >= seasonDays", () => {
    expect(() =>
      parseGameConfig({
        seasonDays: 10,
        league: { teams: 8, turns: 2, startDay: 1, matchIntervalDays: 2 },
        payrollIntervalDays: 7,
        weeklyIntervalDays: 7,
        transferIntervalDays: 1,
        auctionDurationDays: 7,
        loanDurationSeasons: 1,
        stadiumUpgradeDays: 15,
        contractWarningSeasons: 2,
        humanMatchDurationMinutes: 10,
        ...economyFields,
      })
    ).toThrow(/lastMatchDay/);
    expect(() =>
      parseGameConfig({
        seasonDays: 30,
        league: { teams: 1, turns: 2, startDay: 1, matchIntervalDays: 2 },
        payrollIntervalDays: 7,
        weeklyIntervalDays: 7,
        transferIntervalDays: 1,
        auctionDurationDays: 7,
        loanDurationSeasons: 1,
        stadiumUpgradeDays: 15,
        contractWarningSeasons: 2,
        humanMatchDurationMinutes: 10,
        ...economyFields,
      })
    ).toThrow();
  });
});

describe("country name pools", () => {
  it("generates names from the respective country pools (no fallback for pool countries)", () => {
    for (const code of ["BRA", "ING", "JAP"]) {
      expect(hasNamePool(code)).toBe(true);
      const names = poolLines("names", code);
      const surnames = poolLines("surnames", code);
      const rng = createRng(42);
      for (let i = 0; i < 200; i++) {
        const name = generateName(rng, code);
        expect(name.length).toBeGreaterThan(0);
        expect(nameMatchesPool(name, names, surnames), `${name} (${code})`).toBe(true);
      }
    }
  });

  it("falls back to a generic pool for unknown countries", () => {
    expect(hasNamePool("ZZZ")).toBe(false);
    const rng = createRng(7);
    const name = generateName(rng, "ZZZ");
    expect(name.length).toBeGreaterThan(0);
  });

  it("creates a team whose squad and coach match the chosen country pool", () => {
    const world = generateWorld(555);
    const result = assignHumanClub(world, "JAP");
    expect(result.ok).toBe(true);
    const club = world.clubs.find((c) => c.id === result.clubId)!;
    expect(club.isHuman).toBe(true);
    expect(world.humanClubId).toBe(club.id);
    expect(club.country).toBe("JAP");
    const names = poolLines("names", "JAP");
    const surnames = poolLines("surnames", "JAP");
    expect(nameMatchesPool(club.coachName, names, surnames), club.coachName).toBe(true);
    const squad = world.players.filter((p) => p.clubId === club.id);
    expect(squad.length).toBeGreaterThan(20);
    for (const p of squad) {
      expect(nameMatchesPool(p.name, names, surnames), `${p.name}`).toBe(true);
    }
    expect(buildLineup(club, world.players)?.starters.length).toBe(11);
  });

  it("falls back to the club's generated country on an invalid selection", () => {
    const world = generateWorld(556);
    const result = assignHumanClub(world, "ZZZ");
    expect(result.ok).toBe(true);
    const club = world.clubs[0];
    expect(club.country.length).toBe(3);
    expect(hasNamePool(club.country)).toBe(true);
  });
});

describe("season rollover shape", () => {
  it("produces a league-only summary without promotion or cup fields", () => {
    const world = generateWorld(777);
    world.humanClubId = world.clubs[0].id;
    world.clubs[0].isHuman = true;
    let guard = 0;
    while (guard++ < 500) {
      const res = advance(world);
      if (res.matchPending) finishLiveMatch(world);
      if (res.seasonEnded) break;
    }
    const summary = world.seasonSummary!;
    expect(Object.keys(summary).sort()).toEqual(["leagueChampionId", "leagueRunnerUpId"]);
    const champion = world.clubs.find((c) => c.id === summary.leagueChampionId)!;
    expect(champion.trophies["National League"]).toBeGreaterThanOrEqual(1);
  });
});
