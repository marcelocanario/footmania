import { describe, expect, it } from "vitest";
import {
  academyContractSeasonsForAge,
  calculateAcademySalary,
  calculateBaseSalary,
  calculateProfessionalContractSalary,
  contractDaysForTerm,
  professionalAnnualDemandRate,
  remainingSeasonFractionForDay,
} from "../src/game/economy";
import { applyMaxBid, createTransferAuction, settleTransferAuction } from "../src/game/market";
import { offerPlayerForLoan } from "../src/game/loans";
import { generatePlayer } from "../src/game/player";
import { projectDivisionQuality } from "../src/game/generationProjection";
import { expectedFirstDivisionQuality, calculateInitialFirstDivisionSeasonBudget } from "../src/game/budget";
import { createRng } from "../src/game/rng";
import { gameConfig } from "../src/config";
import { makeClub, makeWorld } from "./helpers";
import { calibrationDescribe } from "./calibration";

describe("transfer contract salary", () => {
  function listedWorld(sellerSalary: number, overall: number, age: number) {
    const seller = makeClub({ id: 1, ownerUserId: 1, isHuman: true, cash: 10_000_000 });
    const buyer = makeClub({ id: 2, ownerUserId: 2, isHuman: true, cash: 500_000_000 });
    const player = generatePlayer(createRng(9), seller, { id: 10 });
    player.overall = overall;
    player.age = age;
    player.salary = sellerSalary;
    player.value = 1_000_000;
    const world = makeWorld([seller, buyer], [player]);
    world.mp.completedRounds = 99;
    const listing = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 1, now: Date.now() });
    if (!listing.ok) throw new Error(listing.error);
    return { world, seller, buyer, player, listing: listing.listing };
  }

  it("applies the no-pay-cut floor when buying a player from another club", () => {
    // A player under contract does not accept less to change clubs.
    const overpaidSalary = 9_000_000;
    const { world, buyer, listing } = listedWorld(overpaidSalary, 55, 30);
    const result = applyMaxBid(world, {
      listing,
      club: buyer,
      player: world.players[0],
      proposedMaximum: 1_400_000,
      buyerDivision: 1,
      immediateAvailableCash: 400_000_000,
      contractSeasons: 2,
      now: Date.now(),
    });
    expect(result.ok).toBe(true);
    const bid = world.marketBids.find((candidate) => candidate.clubId === buyer.id)!;
    expect(bid.contractSalary).toBeGreaterThanOrEqual(overpaidSalary);
  });

  it("uses the market salary when the seller's wage is below it", () => {
    const { world, buyer, listing } = listedWorld(1_000, 85, 25);
    applyMaxBid(world, {
      listing,
      club: buyer,
      player: world.players[0],
      proposedMaximum: 1_400_000,
      buyerDivision: 1,
      immediateAvailableCash: 400_000_000,
      contractSeasons: 2,
      now: Date.now(),
    });
    const bid = world.marketBids.find((candidate) => candidate.clubId === buyer.id)!;
    expect(bid.contractSalary).toBeGreaterThan(calculateBaseSalary(85, 25));
  });

  it("does NOT apply the floor to a free-agent signing", () => {
    // An expired salary does not follow a player into free agency.
    const renewal = calculateProfessionalContractSalary({
      currentOverall: 55,
      currentAge: 34,
      futureCompleteSeasons: 1,
      currentSeasonFraction: 1,
      currentSalary: 9_000_000,
    });
    const freeAgent = calculateProfessionalContractSalary({
      currentOverall: 55,
      currentAge: 34,
      futureCompleteSeasons: 1,
      currentSeasonFraction: 1,
    });
    expect(renewal).toBeGreaterThanOrEqual(9_000_000);
    expect(freeAgent).toBeLessThan(renewal);
  });

  it("settles with the winning bidder's frozen contract terms", () => {
    const now = Date.now();
    const { world, buyer, player, listing } = listedWorld(200_000, 70, 26);
    applyMaxBid(world, {
      listing,
      club: buyer,
      player,
      proposedMaximum: 1_400_000,
      buyerDivision: 1,
      immediateAvailableCash: 400_000_000,
      contractSeasons: 3,
      now,
    });
    const bid = world.marketBids.find((candidate) => candidate.clubId === buyer.id)!;
    const settled = settleTransferAuction(world, listing, now + 1, { forceClose: true });
    expect(settled.ok).toBe(true);
    expect(player.clubId).toBe(buyer.id);
    expect(player.salary).toBe(bid.contractSalary);
    expect(player.contractDays).toBe(contractDaysForTerm(3));
  });
});

describe("loan listing contract guards", () => {
  /** `pastJoinThreshold` pushes the season past its configured join lock round. */
  function loanWorld(contractDays: number, pastJoinThreshold: boolean) {
    const club = makeClub({ id: 1, ownerUserId: 1, isHuman: true, cash: 10_000_000 });
    const player = generatePlayer(createRng(3), club, { id: 20 });
    player.contractDays = contractDays;
    const world = makeWorld([club], [player]);
    world.mp.completedRounds = pastJoinThreshold ? world.mp.joinLockRound : 0;
    return { world, club, player };
  }

  it("refuses a listing whose exposure window would outlast the contract", () => {
    const { world, club, player } = loanWorld(1, false);
    const result = offerPlayerForLoan(world, club, player);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/outlast|exceeds/);
  });

  it("refuses a listing in the player's final contractual season past the join threshold", () => {
    const { world, club, player } = loanWorld(gameConfig.seasonDays, true);
    const result = offerPlayerForLoan(world, club, player);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/final contractual season/);
  });

  it("allows the same listing earlier in the season", () => {
    const { world, club, player } = loanWorld(gameConfig.seasonDays * 2, false);
    const result = offerPlayerForLoan(world, club, player);
    expect(result.ok).toBe(true);
  });
});

describe("transfer listing contract guards", () => {
  /** `pastJoinThreshold` pushes the season past its configured join lock round. */
  function saleWorld(contractDays: number, pastJoinThreshold: boolean) {
    const club = makeClub({ id: 1, ownerUserId: 1, isHuman: true, cash: 10_000_000 });
    const player = generatePlayer(createRng(3), club, { id: 20 });
    player.contractDays = contractDays;
    const world = makeWorld([club], [player]);
    world.mp.completedRounds = pastJoinThreshold ? world.mp.joinLockRound : 0;
    return { world, club, player };
  }

  it("refuses a sale listing in the player's final contractual season past the join threshold", () => {
    const { world, club, player } = saleWorld(gameConfig.seasonDays, true);
    const result = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/final contractual season/);
  });

  it("allows the same sale listing earlier in the season", () => {
    const { world, club, player } = saleWorld(gameConfig.seasonDays, false);
    const result = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 1 });
    expect(result.ok).toBe(true);
  });

  it("allows a sale listing for a player with more than a season remaining past the join threshold", () => {
    const { world, club, player } = saleWorld(gameConfig.seasonDays * 2, true);
    const result = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 1 });
    expect(result.ok).toBe(true);
  });
});

describe("derived economy assumptions", () => {
  it("derives the D1 quality assumptions from generation rather than a constant", () => {
    const quality = expectedFirstDivisionQuality();
    const projection = projectDivisionQuality(1, 1);
    expect(quality.fullSquadOverall).toBeCloseTo(projection.fullSquadMean, 9);
    expect(quality.startingXiOverall).toBeCloseTo(projection.startingXiMean, 9);
    // Ordered: squad mean < XI mean < meaningful signing <= elite.
    expect(quality.fullSquadOverall).toBeLessThan(quality.startingXiOverall);
    expect(quality.startingXiOverall).toBeLessThan(quality.meaningfulSigningOverall);
    expect(quality.meaningfulSigningOverall).toBeLessThanOrEqual(quality.eliteOverall);
  });

  it("tracks the configured top-division mean rather than a hard-coded 72", () => {
    const projection = projectDivisionQuality(1, 1);
    expect(Math.abs(projection.fullSquadMean - gameConfig.playerGeneration.topDivisionMeanOverall)).toBeLessThan(1.5);
  });

  it("produces a positive first-division budget consistent with the derived quality", () => {
    expect(calculateInitialFirstDivisionSeasonBudget()).toBeGreaterThan(0);
  });
});

calibrationDescribe("contract and academy salary calibration", () => {
  it("keeps the academy fraction exact across the whole OVR and age grid", () => {
    for (let age = gameConfig.playerGenerationRules.academyMinAge; age <= gameConfig.playerGenerationRules.academyMaxAge; age++) {
      for (let overall = 30; overall <= 95; overall += 5) {
        const professionalEquivalent = calculateProfessionalContractSalary({
          currentOverall: overall,
          currentAge: age,
          futureCompleteSeasons: academyContractSeasonsForAge(age) - 1,
          currentSeasonFraction: 1,
        });
        const academy = calculateAcademySalary(overall, age);
        expect(Math.abs(academy / professionalEquivalent - gameConfig.academySalaryMultiplier), `${overall}/${age}`)
          .toBeLessThan(0.001);
      }
    }
  });

  it("grows the demand monotonically with OVR, term and the youth premium", () => {
    const at = (overall: number, age: number, seasons: number) =>
      calculateProfessionalContractSalary({
        currentOverall: overall,
        currentAge: age,
        futureCompleteSeasons: seasons,
        currentSeasonFraction: remainingSeasonFractionForDay(0),
      });
    for (let overall = 30; overall < 95; overall += 5) {
      expect(at(overall + 5, 26, 2)).toBeGreaterThan(at(overall, 26, 2));
    }
    for (let seasons = 1; seasons < gameConfig.maxContractSeasons; seasons++) {
      expect(at(70, 26, seasons + 1)).toBeGreaterThan(at(70, 26, seasons));
    }
    // The youth premium PEAKS just before first-team age and then fades to
    // nothing through the mid-twenties. A 16-year-old is not yet the asset an
    // 18-year-old is, so the curve rises into the peak before decaying.
    const peakAge = 18;
    for (let age = 16; age < peakAge; age++) {
      expect(professionalAnnualDemandRate(70, age)).toBeLessThanOrEqual(professionalAnnualDemandRate(70, peakAge));
    }
    for (let age = peakAge; age < 30; age++) {
      expect(professionalAnnualDemandRate(70, age)).toBeGreaterThanOrEqual(professionalAnnualDemandRate(70, age + 1));
    }
    // Fully faded by the late twenties: only the minimum and skill terms left.
    expect(professionalAnnualDemandRate(70, 30)).toBeCloseTo(professionalAnnualDemandRate(70, 35), 10);
  });

  it("keeps the annual demand rate inside the configured band for the whole grid", () => {
    for (let overall = 1; overall <= 100; overall++) {
      for (let age = 16; age <= 40; age++) {
        const rate = professionalAnnualDemandRate(overall, age);
        expect(rate).toBeGreaterThanOrEqual(gameConfig.renewalMinRaise);
        expect(rate).toBeLessThanOrEqual(gameConfig.renewalMaxRaise);
      }
    }
  });

  it("keeps a promoted academy player's release clause well below a professional one", () => {
    // The low academy-origin clause is a deliberate mobility mechanism.
    const academy = calculateAcademySalary(75, 19);
    const professional = calculateProfessionalContractSalary({
      currentOverall: 75,
      currentAge: 19,
      futureCompleteSeasons: 2,
      currentSeasonFraction: 1,
    });
    expect(academy).toBeLessThan(professional * 0.5);
  });
});
