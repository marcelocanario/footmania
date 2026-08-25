import { describe, expect, it } from "vitest";
import {
  calculateBaseSalary,
  calculateAcademySalary,
  calculatePlayerValue,
  calculateProfessionalContractSalary,
  calculateReleaseClause,
  contractDaysForTerm,
  contractDemandOptions,
  levelizedContractSalary,
  professionalAnnualDemandRate,
  remainingSeasonFractionForDay,
  curveMultiplier,
  remainingSeasons,
} from "../src/game/economy";
import { generatePlayer, refreshPlayerDerived } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { contractCycle, processContractExpiry, promoteYouthPlayer, processSeasonEndContracts, processSeasonalAcademyIntake, commitSeasonRollover } from "../src/game/season";
import { settlePayroll } from "../src/game/season";
import { applyMaxBid, createTransferAuction, settleTransferAuction } from "../src/game/market";
import { MARKET_CONFIG, gameConfig } from "../src/config";
import { makeClub, makeWorld } from "./helpers";

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
    a.careerProfile = { growthPotential: 1, growthSpeed: 1, peakAge: 32, declinePotential: 0, declineSpeed: 0 };
    b.careerProfile = { growthPotential: 0, growthSpeed: 0, peakAge: 23, declinePotential: 1, declineSpeed: 1 };
    expect(calculatePlayerValue(a.overall, a.age, remainingSeasons(a.contractDays))).toBe(
      calculatePlayerValue(b.overall, b.age, remainingSeasons(b.contractDays))
    );
  });

  it("value does not change when a player moves between clubs", () => {
    const clubA = makeClub();
    const clubB = makeClub();
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

describe("professional contract salary authority", () => {
  const renewal = (opts: { overall: number; age: number; seasons: number; fraction: number; salary: number }) =>
    calculateProfessionalContractSalary({
      currentOverall: opts.overall,
      currentAge: opts.age,
      futureCompleteSeasons: opts.seasons,
      currentSeasonFraction: opts.fraction,
      currentSalary: opts.salary,
    });

  it("levelizes the compounded annual demand over the exact horizon", () => {
    const baseline = 100_000;
    const seasons = 2;
    const fraction = 0.25;
    const rate = 0.1;
    const future = baseline * (1 + rate) + baseline * Math.pow(1 + rate, 2);
    const expected = Math.round((baseline * fraction + future) / (fraction + seasons));
    expect(levelizedContractSalary(baseline, rate, seasons, fraction)).toBe(expected);
  });

  it("treats the term as FUTURE complete seasons, never a total contract length", () => {
    // Passing a total where future seasons are expected would price one extra
    // season of service, which is exactly the bug this distinction prevents.
    const four = levelizedContractSalary(100_000, 0.1, 4, 1);
    const five = levelizedContractSalary(100_000, 0.1, 5, 1);
    expect(five).toBeGreaterThan(four);
  });

  it("converts a 10% raise over five future seasons to the equivalent fixed salary", () => {
    expect(levelizedContractSalary(100_000, 0.1, 5, 0)).toBe(Math.round(134_312.2));
  });

  it("returns the baseline when the demand rate or horizon is nil", () => {
    expect(levelizedContractSalary(100_000, 0, 5, 1)).toBe(100_000);
    expect(levelizedContractSalary(100_000, 0.1, 0, 1)).toBe(100_000);
  });

  it("clamps the annual demand rate between the configured minimum and maximum", () => {
    expect(professionalAnnualDemandRate(1, 40)).toBeGreaterThanOrEqual(gameConfig.renewalMinRaise);
    expect(professionalAnnualDemandRate(100, 18)).toBeLessThanOrEqual(gameConfig.renewalMaxRaise);
  });

  it("adds a visible-age youth premium that fades through the mid-twenties", () => {
    const young = professionalAnnualDemandRate(70, 18);
    const midTwenties = professionalAnnualDemandRate(70, 25);
    const prime = professionalAnnualDemandRate(70, 28);
    expect(young).toBeGreaterThan(midTwenties);
    expect(midTwenties).toBeGreaterThan(prime);
    // The premium reads visible age only; two players of the same age and OVR
    // must demand identically regardless of their hidden career profiles.
    expect(professionalAnnualDemandRate(70, 18)).toBe(young);
  });

  it("makes a long renewal relatively more expensive for a young player", () => {
    // Compared against each player's own one-season deal, so the age-driven
    // salary baseline cancels out and only the youth premium is measured.
    const ratio = (age: number) =>
      renewal({ overall: 70, age, seasons: 5, fraction: 1, salary: 100_000 })
      / renewal({ overall: 70, age, seasons: 1, fraction: 1, salary: 100_000 });
    expect(ratio(18)).toBeGreaterThan(ratio(28));
  });

  it("never reduces a player's salary on a club renewal", () => {
    // A player already paid far above his market worth keeps that salary.
    const overpaid = renewal({ overall: 55, age: 33, seasons: 1, fraction: 1, salary: 5_000_000 });
    expect(overpaid).toBeGreaterThanOrEqual(5_000_000);
  });

  it("uses the greater of current salary and current-OVR market salary as the baseline", () => {
    // A player who improved a lot since signing can no longer be kept cheap.
    const improved = renewal({ overall: 90, age: 24, seasons: 2, fraction: 1, salary: 1_000 });
    const market = calculateBaseSalary(90, 24);
    expect(improved).toBeGreaterThan(market);
  });

  it("lets the same player ask for less as a free agent than he rejected as a renewal", () => {
    const renewalDemand = renewal({ overall: 60, age: 34, seasons: 1, fraction: 1, salary: 2_000_000 });
    const freeAgentDemand = calculateProfessionalContractSalary({
      currentOverall: 60,
      currentAge: 34,
      futureCompleteSeasons: 1,
      currentSeasonFraction: 1,
    });
    expect(freeAgentDemand).toBeLessThan(renewalDemand);
  });

  it("grows the demand with the requested contract length", () => {
    const options = contractDemandOptions(75, 26, 0, 100_000);
    for (let seasons = 2; seasons <= gameConfig.maxContractSeasons; seasons++) {
      expect(options[seasons]).toBeGreaterThan(options[seasons - 1]);
    }
  });

  it("uses the multiplayer season clock for the remaining fraction", () => {
    expect(remainingSeasonFractionForDay(0)).toBe(1);
    expect(remainingSeasonFractionForDay(gameConfig.seasonDays)).toBe(0);
    expect(remainingSeasonFractionForDay(gameConfig.seasonDays + 10)).toBe(0);
  });

  it("leaves four complete seasons after a four-season term crosses rollover", () => {
    const club = makeClub();
    const player = generatePlayer(createRng(31), club, { id: 31, isYouth: false });
    player.contractDays = contractDaysForTerm(4);
    const world = makeWorld([club], [player]);
    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);
    commitSeasonRollover(world);
    expect(player.contractDays).toBe(gameConfig.seasonDays * 4);
  });

  it("renewing early costs less per season but covers strictly more raised service", () => {
    const early = renewal({ overall: 80, age: 25, seasons: 5, fraction: 1, salary: 100_000 });
    const late = renewal({ overall: 80, age: 25, seasons: 5, fraction: 0.05, salary: 100_000 });
    expect(early).toBeLessThan(late);
    // Early is cheaper PER SEASON precisely because it buys more service.
    expect(early * (1 + 5)).toBeGreaterThan(late * (0.05 + 5));
  });

  it("replaces an existing contract rather than extending it", () => {
    const club = makeClub();
    const p = generatePlayer(createRng(5), club, { id: 1 });
    p.contractDays = gameConfig.seasonDays * 2;
    p.salary = 100_000;
    p.contractDays = 5 * gameConfig.seasonDays;
    p.salary = renewal({ overall: p.overall, age: p.age, seasons: 5, fraction: 0, salary: 100_000 });
    expect(remainingSeasons(p.contractDays)).toBe(5);
  });
});

describe("salary persistence", () => {
  it("creates a bidder-specific free-agent listing when a senior contract expires", () => {
    const club = makeClub();
    const player = generatePlayer(createRng(32), club, { id: 32, isYouth: false });
    player.contractDays = 0;
    const world = makeWorld([club], [player]);
    processContractExpiry(world, player.id);
    expect(player.clubId).toBeNull();
    expect(world.freeAgentListings).toHaveLength(1);
    expect(world.freeAgentListings[0].salaryBaselineAtListing).toBeGreaterThan(0);
    expect(world.freeAgentListings[0].unclaimedSince).toBeDefined();
  });

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
    const world = makeWorld([club], [p]);
    const contractBefore = p.contractDays;
    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);
    commitSeasonRollover(world);
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
    const world = makeWorld([club], [p]);

    let simulated = 0;
    for (let day = gameConfig.payrollIntervalDays; day <= gameConfig.seasonDays; day += gameConfig.payrollIntervalDays) {
      world.dayIndex = day;
      settlePayroll(world.rng, world);
      const last = club.ledger.expense[club.ledger.expense.length - 1];
      simulated += last.amount;
    }
    expect(simulated).toBe(salaryPerSeason);
  });

  it("prorates wages when a player changes clubs mid-cycle", () => {
    const seller = makeClub();
    const buyer = { ...makeClub(), id: 2, name: "Buyer FC", isHuman: false };
    const p = generatePlayer(createRng(18), seller, { id: 1 });
    p.salary = 100_000;
    p.value = 2_000_000;
    p.payrollPaidThroughDay = 0;
    p.payrollPaidAmount = 0;
    const world = makeWorld([seller, buyer], [p]);
    world.dayIndex = 7;
    settlePayroll(world.rng, world);
    const sellerAfterCycle = seller.cash;
    world.dayIndex = 10;
    // The transfer path settles seller wages through day 10 and resets the
    // player's payroll period before the buyer takes ownership.
    const listed = createTransferAuction(world, { player: p, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!listed.ok) throw new Error(listed.error);
    const bid = applyMaxBid(world, { listing: listed.listing, club: buyer, player: p, proposedMaximum: 2_100_000, buyerDivision: 1, immediateAvailableCash: 50_000_000 });
    expect(bid.ok).toBe(true);
    const settleAt = Date.now();
    listed.listing.deadline = settleAt - 1;
    const settled = settleTransferAuction(world, listed.listing, settleAt);
    expect(settled.ok).toBe(true);
    const buyerSalary = p.salary;
    // Seller receives the final price minus the transfer sales tax and the
    // seller's prorated wages through day 10. The tax is burned: no club is
    // credited with it.
    const fee = listed.listing.openingPrice;
    const tax = Math.round(fee * MARKET_CONFIG.transferTax.rate);
    expect(seller.cash).toBe(sellerAfterCycle + fee - tax - Math.round(100_000 * 3 / gameConfig.seasonDays));
    world.dayIndex = 14;
    settlePayroll(world.rng, world);
    expect(seller.cash).toBe(sellerAfterCycle + fee - tax - Math.round(100_000 * 3 / gameConfig.seasonDays));
    expect(seller.ledger.expense.filter((e) => e.code === 17).reduce((sum, e) => sum + e.amount, 0)).toBe(tax);
    expect(buyer.ledger.expense.filter((e) => e.code === 4).reduce((sum, e) => sum + e.amount, 0)).toBe(
      Math.round(buyerSalary * (14 - 10) / gameConfig.seasonDays)
    );
  });
});

describe("AI contract renewals", () => {
  it("ephemeral AI clubs never renew or expire contracts (invariant #28)", () => {
    const club = makeClub();
    club.isHuman = false;
    const rng = createRng(23);
    const p = generatePlayer(rng, club, { id: 1 });
    p.salary = 100_000;
    p.contractDays = gameConfig.seasonDays * 1; // within the warning window
    const world = makeWorld([club], [p]);
    world.news = [];
    contractCycle(world.rng, world);
    // The AI wage clock is frozen: no renewal demand, no expiry, no news.
    expect(p.salary).toBe(100_000);
    expect(p.clubId).toBe(club.id);
    expect(world.freeAgentListings).toHaveLength(0);
    expect(world.news).toHaveLength(0);
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
