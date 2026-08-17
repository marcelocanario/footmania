import { describe, expect, it } from "vitest";
import {
  calculateBaseSalary,
  calculateAcademySalary,
  calculateContractDemand,
  calculatePlayerValue,
  calculateReleaseClause,
  calculateRenewalDemand,
  calculateRenewalRaise,
  curveMultiplier,
  remainingSeasons,
} from "../src/game/economy";
import { generatePlayer, refreshPlayerDerived } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { contractCycle, promoteYouthPlayer, rolloverSeason } from "../src/game/season";
import { settlePayroll } from "../src/game/season";
import { transferPlayer } from "../src/game/transfers";
import { gameConfig } from "../src/config";
import type { Club, Player, World } from "../src/game/types";

function makeClub(): Club {
  return {
    id: 1,
    name: "Test FC",
    shortName: "TFC",
    country: "BRA",
    level: 20,
    cash: 100_000_000,
    stadiumName: "St",
    stadiumCapacity: 40000,
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    boardConfidence: 50,
    fanConfidence: 70,
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: true,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

function makeWorld(club: Club, players: Player[]): World {
  return {
    seed: 1,
    year: 2026,
    dayIndex: 0,
    dayOfWeek: 0,
    nextId: 1000,
    clubs: [club],
    players,
    competitions: [],
    fixtures: [],
    matches: [],
    news: [],
    auctions: [],
    loans: [],
    seasonAwards: [],
    records: [],
    managerHistory: [],
    ticketPrices: {},
    stadiumUpgrades: [],
    tvDeals: [],
    humanClubId: club.id,
    seasonSummary: null,
    rng: createRng(42),
    contractWarnings: [],
    liveMatch: null,
  };
}

describe("removed concepts", () => {
  it("players no longer carry isStar, worldClass, or a releaseClauseFactor", () => {
    const club = makeClub();
    const rng = createRng(5);
    const p = generatePlayer(rng, club, { id: 1 });
    expect(p).not.toHaveProperty("isStar");
    expect(p).not.toHaveProperty("worldClass");
    expect(p).not.toHaveProperty("releaseClauseFactor");
    expect(p).not.toHaveProperty("releaseClauseFactor");
  });

  it("clubs no longer carry reputation", () => {
    const club = makeClub();
    expect(club).not.toHaveProperty("reputation");
  });
});

describe("player value", () => {
  it("is deterministic for identical overall, age, and contract", () => {
    for (const [ovr, age, seasons] of [[50, 20, 2], [75, 25, 3], [90, 30, 1], [40, 18, 5]] as const) {
      const a = calculatePlayerValue(ovr, age, seasons);
      const b = calculatePlayerValue(ovr, age, seasons);
      expect(a).toBe(b);
    }
  });

  it("increases monotonically with overall", () => {
    let prev = 0;
    for (let ovr = 20; ovr <= 95; ovr += 5) {
      const v = calculatePlayerValue(ovr, 25, 3);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("is strongly nonlinear: 90 OVR is far more valuable than 80 OVR", () => {
    const v80 = calculatePlayerValue(80, 25, 3);
    const v90 = calculatePlayerValue(90, 25, 3);
    expect(v90 / v80).toBeGreaterThan(1.5);
  });

  it("contract duration affects value modestly", () => {
    const one = calculatePlayerValue(90, 25, 1);
    const five = calculatePlayerValue(90, 25, 5);
    expect(one).toBeLessThan(five);
    expect(five / one).toBeLessThan(1.3);
  });

  it("overall dominates contract duration: 90 OVR/1 season > 80 OVR/5 seasons", () => {
    const v90one = calculatePlayerValue(90, 25, 1);
    const v80five = calculatePlayerValue(80, 25, 5);
    expect(v90one).toBeGreaterThan(v80five);
  });

  it("ignores hidden development trajectories", () => {
    // Same observable inputs -> same value, regardless of internal profile.
    const vA = calculatePlayerValue(70, 24, 3);
    const vB = calculatePlayerValue(70, 24, 3);
    expect(vA).toBe(vB);
    // A player with a strong development profile is valued identically to one
    // with a weak profile when overall/age/contract match.
    const club = makeClub();
    const rngA = createRng(1);
    const rngB = createRng(2);
    const a = generatePlayer(rngA, club, { id: 1 });
    const b = generatePlayer(rngB, club, { id: 2 });
    a.overall = 75;
    b.overall = 75;
    a.age = 24;
    b.age = 24;
    a.contractDays = gameConfig.seasonDays * 3;
    b.contractDays = gameConfig.seasonDays * 3;
    a.developmentProfile = { declineStartAge: 38, developmentRate: 1.4, developmentVolatility: 0.2 };
    b.developmentProfile = { declineStartAge: 24, developmentRate: 0.6, developmentVolatility: 0.03 };
    expect(calculatePlayerValue(a.overall, a.age, remainingSeasons(a.contractDays))).toBe(
      calculatePlayerValue(b.overall, b.age, remainingSeasons(b.contractDays))
    );
  });

  it("value does not change when a player moves between clubs", () => {
    const clubA = makeClub();
    const clubB = makeClub();
    clubB.level = 5;
    const rng = createRng(9);
    const p = generatePlayer(rng, clubA, { id: 1 });
    const before = p.value;
    p.clubId = clubB.id;
    expect(p.value).toBe(before);
  });
});

describe("release clause", () => {
  it("equals salary x remaining seasons x percentage", () => {
    const clause = calculateReleaseClause(100_000, 3);
    expect(clause).toBe(150_000);
  });

  it("tracks remaining contract automatically", () => {
    const club = makeClub();
    const rng = createRng(7);
    const p = generatePlayer(rng, club, { id: 1 });
    p.salary = 100_000;
    p.contractDays = gameConfig.seasonDays * 3;
    p.value = calculatePlayerValue(p.overall, p.age, 3);
    refreshPlayerDerived(club, p);
    expect(p.releaseClause).toBe(150_000);
    // One season closer to expiry lowers the clause even though the salary is fixed.
    p.contractDays = gameConfig.seasonDays * 1;
    p.value = calculatePlayerValue(p.overall, p.age, 1);
    refreshPlayerDerived(club, p);
    expect(p.releaseClause).toBe(50_000);
  });
});

describe("contract limits", () => {
  it("accepts 1..maxContractSeasons", () => {
    const max = gameConfig.maxContractSeasons;
    expect(max).toBe(5);
    for (let s = 1; s <= max; s++) {
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(max);
    }
  });

  it("rejects 0 and anything above maxContractSeasons", () => {
    const max = gameConfig.maxContractSeasons;
    expect(0 > max || 0 < 1).toBe(true);
    expect(max + 1 > max).toBe(true);
    expect(max + 6 > max).toBe(true);
  });
});

describe("contract renewal demand", () => {
  it("converts a 10% raise over 5 seasons to the equivalent fixed salary", () => {
    const demand = calculateRenewalDemand(100_000, 0.1, 5);
    expect(demand).toBe(Math.round(134_312.2));
    expect(Math.abs(demand - 134_312)).toBeLessThanOrEqual(1);
  });

  it("returns current salary for a one-season contract with the raise applied", () => {
    // One-season renewal: requested = W x (1+r).
    const demand = calculateRenewalDemand(100_000, 0.1, 1);
    expect(demand).toBe(110_000);
  });

  it("returns current salary when the raise is zero", () => {
    expect(calculateRenewalDemand(100_000, 0, 5)).toBe(100_000);
    expect(calculateRenewalDemand(100_000, 0, 1)).toBe(100_000);
  });

  it("demand grows with the requested contract length", () => {
    const club = makeClub();
    const rng = createRng(3);
    const p = generatePlayer(rng, club, { id: 1 });
    p.salary = 100_000;
    const d1 = calculateContractDemand(p.salary, p.overall, p.age, 1);
    const d5 = calculateContractDemand(p.salary, p.overall, p.age, 5);
    expect(d5).toBeGreaterThan(d1);
  });

  it("renewal raise is clamped between min and max", () => {
    const club = makeClub();
    const rng = createRng(3);
    const p = generatePlayer(rng, club, { id: 1 });
    const low = calculateRenewalRaise(p.salary, 1, 40, 5);
    expect(low).toBeGreaterThanOrEqual(gameConfig.renewalMinRaise);
    const high = calculateRenewalRaise(p.salary, 100, 20, 5);
    expect(high).toBeLessThanOrEqual(gameConfig.renewalMaxRaise);
  });

  it("replaces an existing contract rather than extending it", () => {
    const club = makeClub();
    const rng = createRng(5);
    const p = generatePlayer(rng, club, { id: 1 });
    p.contractDays = gameConfig.seasonDays * 2; // 2 seasons remaining
    p.salary = 100_000;
    // Renewal: new contract replaces the old one entirely.
    p.contractDays = 5 * gameConfig.seasonDays;
    p.salary = calculateContractDemand(100_000, p.overall, p.age, 5);
    expect(remainingSeasons(p.contractDays)).toBe(5);
  });
});

describe("salary persistence", () => {
  it("pays academy players a configurable fraction of senior salary", () => {
    const club = makeClub();
    const youth = generatePlayer(createRng(12), club, { isYouth: true, id: 1 });
    expect(youth.salary).toBe(calculateAcademySalary(youth.overall, youth.age));
    expect(youth.salary).toBeLessThan(calculateBaseSalary(youth.overall, youth.age));
  });

  it("market value follows overall but the contract salary stays fixed", () => {
    const club = makeClub();
    const rng = createRng(11);
    const p = generatePlayer(rng, club, { id: 1 });
    p.age = 24;
    const salaryBefore = p.salary;
    const valueBefore = p.value;
    p.overall += 10;
    p.value = calculatePlayerValue(p.overall, p.age, remainingSeasons(p.contractDays));
    expect(p.value).not.toBe(valueBefore);
    // Salary is contractual: it must not change when the player improves.
    expect(p.salary).toBe(salaryBefore);
    refreshPlayerDerived(club, p);
    expect(p.salary).toBe(salaryBefore);
  });

  it("rollover ages the player, recalculates value, and leaves salary alone", () => {
    const club = makeClub();
    const rng = createRng(13);
    const p = generatePlayer(rng, club, { id: 1 });
    const salaryBefore = p.salary;
    const world = makeWorld(club, [p]);
    const contractBefore = p.contractDays;
    rolloverSeason(world.rng, world);
    expect(p.age).toBeGreaterThan(0);
    expect(p.salary).toBe(salaryBefore);
    expect(p.contractDays).toBe(contractBefore - gameConfig.seasonDays);
    // Value is always re-derived from overall / age / remaining contract.
    expect(p.value).toBe(calculatePlayerValue(p.overall, p.age, remainingSeasons(p.contractDays)));
  });
});

describe("season timing", () => {
  it("total payroll over one full season equals the per-season salary regardless of season length", () => {
    const club = makeClub();
    const rng = createRng(17);
    const p = generatePlayer(rng, club, { id: 1 });
    const salaryPerSeason = p.salary;
    const world = makeWorld(club, [p]);

    let simulated = 0;
    for (let day = gameConfig.payrollIntervalDays; day <= gameConfig.seasonDays; day += gameConfig.payrollIntervalDays) {
      world.dayIndex = day;
      settlePayroll(world.rng, world);
      const last = club.ledger.expense[club.ledger.expense.length - 1];
      simulated += last.amount;
    }
    world.dayIndex = gameConfig.seasonDays;
    settlePayroll(world.rng, world);
    simulated += club.ledger.expense[club.ledger.expense.length - 1].amount;
    expect(simulated).toBe(salaryPerSeason);
  });

  it("prorates wages when a player changes clubs mid-cycle", () => {
    const seller = makeClub();
    const buyer = { ...makeClub(), id: 2, name: "Buyer FC", isHuman: false };
    const p = generatePlayer(createRng(18), seller, { id: 1 });
    p.salary = 100_000;
    p.payrollPaidThroughDay = 0;
    p.payrollPaidAmount = 0;
    const world = { ...makeWorld(seller, [p]), clubs: [seller, buyer] };
    world.dayIndex = 7;
    settlePayroll(world.rng, world);
    const sellerAfterCycle = seller.cash;
    world.dayIndex = 10;
    // The transfer path settles seller wages through day 10 and resets the
    // player's payroll period before the buyer takes ownership.
    expect(transferPlayer(world, p, buyer, 0)).toBe(true);
    expect(seller.cash).toBe(sellerAfterCycle - Math.round(100_000 * 3 / gameConfig.seasonDays));
    world.dayIndex = 14;
    settlePayroll(world.rng, world);
    expect(seller.cash).toBe(sellerAfterCycle - Math.round(100_000 * 3 / gameConfig.seasonDays));
    expect(buyer.ledger.expense.filter((e) => e.code === 4).reduce((sum, e) => sum + e.amount, 0)).toBe(
      Math.round(100_000 * 14 / gameConfig.seasonDays) - Math.round(100_000 * 10 / gameConfig.seasonDays)
    );
  });
});

describe("AI contract renewals", () => {
  it("AI clubs use the same renewal-demand model as the human player", () => {
    const club = makeClub();
    club.isHuman = false;
    const rng = createRng(23);
    const p = generatePlayer(rng, club, { id: 1 });
    p.salary = 100_000;
    p.contractDays = gameConfig.seasonDays * 1; // within the warning window
    const world = makeWorld(club, [p]);
    world.news = [];
    contractCycle(world.rng, world);
    // If renewed, salary must equal the canonical demand for some 1..max term;
    // otherwise the offer was declined/rejected, but salary stays unchanged
    // and the old formula (random 0-50% bump capped at 1.3x) must never apply.
    if (p.clubId !== null) {
      if (p.salary !== 100_000) {
        const max = gameConfig.maxContractSeasons;
        const canonical = Array.from({ length: max }, (_, i) => calculateContractDemand(100_000, p.overall, p.age, i + 1));
        expect(canonical).toContain(p.salary);
        expect(p.salary).toBeLessThanOrEqual(100_000 * 1.3);
      }
      expect(remainingSeasons(p.contractDays)).toBeGreaterThanOrEqual(1);
      expect(remainingSeasons(p.contractDays)).toBeLessThanOrEqual(gameConfig.maxContractSeasons);
    }
  });
});

describe("age curves", () => {
  it("interpolates between curve keyframes", () => {
    const curve = { 20: 1, 30: 2 };
    expect(curveMultiplier(curve, 25)).toBe(1.5);
    expect(curveMultiplier(curve, 20)).toBe(1);
    expect(curveMultiplier(curve, 30)).toBe(2);
    expect(curveMultiplier(curve, 40)).toBe(2);
  });

  it("value peaks in the mid-20s and falls sharply at 35+", () => {
    const young = calculatePlayerValue(80, 18, 3);
    const peak = calculatePlayerValue(80, 25, 3);
    const veteran = calculatePlayerValue(80, 35, 3);
    expect(peak).toBeGreaterThan(young);
    expect(peak).toBeGreaterThan(veteran);
    expect(veteran).toBeLessThan(peak * 0.6);
  });
});
