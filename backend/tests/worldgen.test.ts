import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateWorld, createHumanClub } from "../src/game/worldgen";
import { initSeason } from "../src/game/multiplayer";
import { buildLineup } from "../src/game/club";
import { generateName, hasNamePool } from "../src/game/names";
import { createRng } from "../src/game/rng";
import { parseGameConfig } from "../src/config";
import { sortedStandings } from "../src/game/league";
import type { World } from "../src/game/types";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(readFileSync(join(here, "..", "assets", "namepools.json"), "utf8")) as {
  countries: Record<string, { names: string[]; surnames: string[] }>;
};

function poolLines(kind: "names" | "surnames", code: string): Set<string> {
  const lines = kind === "names" ? artifact.countries[code]?.names : artifact.countries[code]?.surnames;
  return new Set(lines ?? []);
}

const NAME_STOPWORDS = new Set(["de", "da", "do", "dos", "das", "van", "von", "del", "della", "di", "el", "al", "ibn", "bin", "o'", "mc", "mac"]);

function nameMatchesPool(name: string, names: Set<string>, surnames: Set<string>): boolean {
  if (names.has(name) || surnames.has(name)) return true;
  const words = name.split(/\s+/);
  return words.every((w) => names.has(w) || surnames.has(w) || NAME_STOPWORDS.has(w.toLowerCase()));
}

describe("worldgen", () => {
  it("builds a Division 1 with 8 clubs and 56 fixtures after season init", () => {
    const world = generateWorld(12345);
    initSeason(world, { year: 2026, month: 1 }, 1);
    expect(world.clubs.length).toBe(8);
    expect(world.players.length).toBeGreaterThan(150);
    const div = world.competitions.find((c) => c.kind === "division")!;
    expect(div).toBeDefined();
    expect(div.name).toBe("1");
    expect(Object.keys(div.standings).length).toBe(8);
    const fixtures = world.fixtures.filter((f) => f.competitionId === div.id);
    expect(fixtures.length).toBe(56);
    const matchDays = new Set(fixtures.map((f) => f.dayIndex));
    expect(matchDays.size).toBe(14);
  });

  it("every club can build a legal 11", () => {
    const world = generateWorld(999);
    initSeason(world, { year: 2026, month: 1 }, 1);
    for (const club of world.clubs) {
      const lineup = buildLineup(club, world.players);
      expect(lineup?.starters.length, `${club.name} starters`).toBe(11);
    }
  });

  it("a created human club owns its own roster and finances", () => {
    const world = generateWorld(555);
    const club = createHumanClub(world, {
      userId: 1,
      clubName: "Marcelo FC",
      country: "BRA",
      timezone: "America/Sao_Paulo",
    });
    expect(club.ownerUserId).toBe(1);
    expect(club.isHuman).toBe(true);
    expect(club.competitionState).toBe("NEW");
    expect(world.clubs.find((c) => c.id === club.id)).toBeDefined();
    const squad = world.players.filter((p) => p.clubId === club.id);
    expect(squad.length).toBeGreaterThan(20);
    expect(buildLineup(club, world.players)?.starters.length).toBe(11);
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
    const club = createHumanClub(world, {
      userId: 1,
      clubName: "Tokyo FC",
      country: "JAP",
      timezone: "Asia/Tokyo",
    });
    expect(club.ownerUserId).toBe(1);
    expect(club.isHuman).toBe(true);
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
});
