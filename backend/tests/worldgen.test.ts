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
    firstDivisionSeasonBudget: 10000000,
    minimumTierBudgetRatio: 0.3,
    tierBudgetDecayRate: 0.55,
    playerValueBase: 1,
    playerValueCareerWeight: 0.5,
    playerValueContractRange: 0.1,
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
    renewalYouthPremiumWeight: 0.05,
    renewalYouthPremiumAgeCurve: { 18: 1, 27: 0 },
    releaseClauseRemainingValuePct: 0.5,
    freeAgentPool: {
      expectedExpiriesPerActiveClubPerSeason: 4,
      signingProbability: 0.6,
      signedResidenceSeasons: 0.1,
    },
    playerGeneration: {
      topDivisionMeanOverall: 74,
      playerQualitySpreadOverall: 5.5,
      academyQualitySpreadOverall: 6,
      divisionOverallSpan: 18,
      seniorPeakOverallOffset: 6.7,
      academyPedigreeOverallBoost: 18,
      academyCurrentDivisionWeight: 0.65,
      academyHighestEverDivisionWeight: 0.35,
      initialSeniorHistoricalActivity: 0.85,
      initialSeniorQualityPairingAgeBandWidth: 5,
      initialClubTargetMeanOffsetOverall: 1.0,
      initialClubTargetBandHalfWidthOverall: 8.0,
      initialClubPlayerValueTargetTopDivision: 40_000_000,
      positionMix: {
        seniorGroups: { GK: 0.10, FB: 0.14, CB: 0.18, MF: 0.32, FW: 0.26 },
        academyGroups: { GK: 0.10, FB: 0.28, CB: 0.26, MF: 0.22, FW: 0.14 },
        withinGroup: {
          GK: { GK: 1 },
          FB: { LB: 0.5, RB: 0.5 },
          CB: { CB: 1 },
          MF: { DM: 0.5, AM: 0.5 },
          FW: { LW: 2 / 7, RW: 2 / 7, ST: 3 / 7 },
        },
      },
    },
    playerPositions: {
      overallByGroup: {
        GK: { scale: 1.15, weights: { gol: 0.80, pace: 0.08, tec: 0.06, pas: 0.04, des: 0.01, playmaking: 0.01 } },
        FB: { scale: 1.25, weights: { des: 0.45, pace: 0.16, pas: 0.16, tec: 0.12, playmaking: 0.07, fin: 0.03, gol: 0.01 } },
        CB: { scale: 1.17, weights: { des: 0.56, playmaking: 0.12, pas: 0.12, pace: 0.08, tec: 0.07, fin: 0.04, gol: 0.01 } },
        MF: { scale: 1.30, weights: { pas: 0.25, playmaking: 0.25, tec: 0.20, pace: 0.12, des: 0.10, fin: 0.07, gol: 0.01 } },
        FW: { scale: 1.20, weights: { fin: 0.46, pace: 0.20, tec: 0.15, playmaking: 0.08, pas: 0.07, des: 0.03, gol: 0.01 } },
      },
      tacticalRatingByRole: {
        GK: { gol: 0.60, tec: 0.15, pace: 0.15, pas: 0.10 },
        LB: { des: 0.40, pas: 0.30, pace: 0.10, tec: 0.10, playmaking: 0.05, fin: 0.05 },
        RB: { des: 0.40, pas: 0.30, pace: 0.10, tec: 0.10, playmaking: 0.05, fin: 0.05 },
        CB: { des: 0.50, pace: 0.25, tec: 0.10, pas: 0.10, playmaking: 0.05 },
        SW: { des: 0.45, pas: 0.20, pace: 0.15, tec: 0.10, playmaking: 0.10 },
        DM: { des: 0.40, pas: 0.20, pace: 0.15, tec: 0.10, playmaking: 0.10, fin: 0.05 },
        AM: { playmaking: 0.40, pas: 0.25, tec: 0.10, pace: 0.10, fin: 0.10, des: 0.05 },
        LM: { pace: 0.25, pas: 0.25, playmaking: 0.20, tec: 0.15, fin: 0.10, des: 0.05 },
        RM: { pace: 0.25, pas: 0.25, playmaking: 0.20, tec: 0.15, fin: 0.10, des: 0.05 },
        LW: { fin: 0.40, pace: 0.25, tec: 0.25, pas: 0.05, playmaking: 0.05 },
        RW: { fin: 0.40, pace: 0.25, tec: 0.25, pas: 0.05, playmaking: 0.05 },
        ST: { fin: 0.40, pace: 0.25, tec: 0.15, pas: 0.15, playmaking: 0.05 },
      },
      athleticismWeights: { pace: 0.5, des: 0.5 },
      trainingFocusBonus: 0.20,
    },
    playerCareer: {
      maximumCareerGrowthOverall: 30,
      maximumCareerDeclineOverall: 26,
      growthPotentialDistribution: [[0, 0.5], [1, 1]],
      growthSpeedDistribution: [[0, 1], [1, 1]],
      declinePotentialDistribution: [[0, 1], [1, 1]],
      declineSpeedDistribution: [[0, 1], [1, 1]],
      growthSlowCurve: [[0, 0], [0.5, 0.3], [1, 1]],
      growthFastCurve: [[0, 0], [0.5, 0.7], [1, 1]],
      peakAgeDistribution: { mean: 27, stdDev: 2.4, min: 23, max: 33 },
      declineSlowCurve: [[0, 0], [6, 0.3], [14, 1]],
      declineFastCurve: [[0, 0], [6, 0.7], [14, 1]],
      generationHistoricalActivity: 0.7,
      freeAgentTerminalLossAgeCurve: { 20: 0.01, 34: 0.1 },
    },
    playerGenerationRules: {
      initialSeniorSquadSize: 28,
      initialAcademySize: 8,
      academyRosterLimit: 12,
      academyMinAge: 16,
      academyMaxAge: 19,
      academyVoluntaryPromotionAge: 18,
      academyAutomaticPromotionAge: 20,
      academyContractEndAge: 21,
      targetOwnedPlayersPerActiveClub: 36,
      minimumAcademyIntakePerActiveClub: 1,
    },
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

  it("rejects malformed career potential densities and cumulative curves", () => {
    const withCareer = (career: Record<string, unknown>) => () =>
      parseGameConfig({
        seasonDays: 30,
        league: { teams: 8, turns: 2, startDay: 1, matchIntervalDays: 2 },
        payrollIntervalDays: 7,
        weeklyIntervalDays: 7,
        contractWarningSeasons: 2,
        ...economyFields,
        playerCareer: { ...economyFields.playerCareer, ...career },
      });
    // A density outside 0-1, with negative mass, or not spanning the interval.
    expect(withCareer({ growthPotentialDistribution: [[0, 1], [1.5, 1]] })).toThrow();
    expect(withCareer({ growthPotentialDistribution: [[0, -1], [1, -1]] })).toThrow();
    expect(withCareer({ growthPotentialDistribution: [[0, 0], [1, 0]] })).toThrow();
    expect(withCareer({ growthSpeedDistribution: [[0.2, 1], [1, 1]] })).toThrow();
    // Curves must start at zero, terminate at one, and stay monotonic.
    expect(withCareer({ growthSlowCurve: [[0, 0.2], [1, 1]] })).toThrow();
    expect(withCareer({ growthSlowCurve: [[0, 0], [1, 0.9]] })).toThrow();
    expect(withCareer({ growthSlowCurve: [[0, 0], [0.5, 0.6], [1, 1]], growthFastCurve: [[0, 0], [0.5, 0.4], [1, 1]] })).toThrow();
    expect(withCareer({ declineSlowCurve: [[0, 0], [6, 0.9], [14, 1]], declineFastCurve: [[0, 0], [6, 0.3], [14, 1]] })).toThrow();
    // Peak age needs a positive deviation and ordered bounds.
    expect(withCareer({ peakAgeDistribution: { mean: 27, stdDev: 0, min: 23, max: 33 } })).toThrow();
    expect(withCareer({ peakAgeDistribution: { mean: 27, stdDev: 2, min: 33, max: 23 } })).toThrow();
  });

  it("rejects inconsistent academy age boundaries and an out-of-range academy multiplier", () => {
    const withOverrides = (overrides: Record<string, unknown>) => () =>
      parseGameConfig({
        seasonDays: 30,
        league: { teams: 8, turns: 2, startDay: 1, matchIntervalDays: 2 },
        payrollIntervalDays: 7,
        weeklyIntervalDays: 7,
        contractWarningSeasons: 2,
        ...economyFields,
        ...overrides,
      });
    const rules = economyFields.playerGenerationRules;
    // Automatic promotion must come after the oldest generated academy age.
    expect(withOverrides({ playerGenerationRules: { ...rules, academyAutomaticPromotionAge: 19 } })).toThrow(/academyAutomaticPromotionAge/);
    // Contract expiry must come after automatic promotion.
    expect(withOverrides({ playerGenerationRules: { ...rules, academyContractEndAge: 20 } })).toThrow(/academyContractEndAge/);
    // Voluntary promotion must sit inside the academy age range.
    expect(withOverrides({ playerGenerationRules: { ...rules, academyVoluntaryPromotionAge: 15 } })).toThrow(/academyVoluntaryPromotionAge/);
    // The academy salary fraction must be strictly inside 0..1.
    expect(withOverrides({ academySalaryMultiplier: 0 })).toThrow(/academySalaryMultiplier/);
    expect(withOverrides({ academySalaryMultiplier: 1 })).toThrow(/academySalaryMultiplier/);
    // Pedigree weights must have a positive sum.
    expect(withOverrides({
      playerGeneration: { ...economyFields.playerGeneration, academyCurrentDivisionWeight: 0, academyHighestEverDivisionWeight: 0 },
    })).toThrow(/pedigree/);
    // Market value divides by the senior quality spread to place an OVR on the
    // budget tier curve, so zero would produce infinite tiers and prices.
    expect(withOverrides({ playerGeneration: { ...economyFields.playerGeneration, playerQualitySpreadOverall: 0 } })).toThrow(/playerQualitySpreadOverall/);
    expect(withOverrides({ playerGeneration: { ...economyFields.playerGeneration, academyQualitySpreadOverall: 0 } })).toThrow(/academyQualitySpreadOverall/);
  });

  it("rejects out-of-range initial-senior pairing settings", () => {
    const withOverrides = (overrides: Record<string, unknown>) => () =>
      parseGameConfig({
        seasonDays: 30,
        league: { teams: 8, turns: 2, startDay: 1, matchIntervalDays: 2 },
        payrollIntervalDays: 7,
        weeklyIntervalDays: 7,
        contractWarningSeasons: 2,
        ...economyFields,
        playerGeneration: { ...economyFields.playerGeneration, ...overrides },
      });
    // initialSeniorHistoricalActivity must be inside 0..1.
    expect(withOverrides({ initialSeniorHistoricalActivity: -0.1 })).toThrow(/initialSeniorHistoricalActivity/);
    expect(withOverrides({ initialSeniorHistoricalActivity: 1.1 })).toThrow(/initialSeniorHistoricalActivity/);
    // Pairing age-band width must be an integer inside 1..20.
    expect(withOverrides({ initialSeniorQualityPairingAgeBandWidth: 0 })).toThrow(/initialSeniorQualityPairingAgeBandWidth/);
    expect(withOverrides({ initialSeniorQualityPairingAgeBandWidth: 21 })).toThrow(/initialSeniorQualityPairingAgeBandWidth/);
    expect(withOverrides({ initialSeniorQualityPairingAgeBandWidth: 2.5 })).toThrow(/initialSeniorQualityPairingAgeBandWidth/);
    // Mean offset inside -20..20.
    expect(withOverrides({ initialClubTargetMeanOffsetOverall: -21 })).toThrow(/initialClubTargetMeanOffsetOverall/);
    expect(withOverrides({ initialClubTargetMeanOffsetOverall: 21 })).toThrow(/initialClubTargetMeanOffsetOverall/);
    // Band half width strictly positive, at most 30.
    expect(withOverrides({ initialClubTargetBandHalfWidthOverall: 0 })).toThrow(/initialClubTargetBandHalfWidthOverall/);
    expect(withOverrides({ initialClubTargetBandHalfWidthOverall: 31 })).toThrow(/initialClubTargetBandHalfWidthOverall/);
    // D1 value target is a positive integer.
    expect(withOverrides({ initialClubPlayerValueTargetTopDivision: 0 })).toThrow(/initialClubPlayerValueTargetTopDivision/);
    expect(withOverrides({ initialClubPlayerValueTargetTopDivision: 1.5 })).toThrow(/initialClubPlayerValueTargetTopDivision/);
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

  it("uses the manager name supplied during human club creation", () => {
    const world = generateWorld(556);
    const club = createHumanClub(world, {
      userId: 2,
      clubName: "Named FC",
      country: "BRA",
      coachName: "Rafa Silva",
    });
    expect(club.coachName).toBe("Rafa Silva");
    expect(club.coachNameChangedSeasonKey).toBeNull();
  });
});
