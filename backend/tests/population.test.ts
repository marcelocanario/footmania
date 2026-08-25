import { describe, expect, it } from "vitest";
import { generatePlayer } from "../src/game/player";
import { generateWorld } from "../src/game/worldgen";
import { dismissYouthPlayer, processSeasonEndContracts, processSeasonalAcademyIntake } from "../src/game/season";
import { generateYouthPlayer } from "../src/game/playerGeneration";
import { deleteUnclaimedFreeAgent } from "../src/game/freeAgents";
import { createRng } from "../src/game/rng";
import { gameConfig } from "../src/config";
import type { Club, Player, Position, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";
import {
  activePopulation,
  allocatedIntakeForClub,
  commitSeasonalIntake,
  ensurePopulationLedger,
  isActivePersistentClub,
  pendingYouthDismissalCount,
  planSeasonalIntake,
  recordActiveClubBoundaryChange,
  recordExtraNonAcademyGeneration,
  recordTerminalDeletion,
  recordYouthDismissal,
  targetActivePopulation,
  targetFreeAgentPool,
} from "./populationHelpers";
import { calibrationDescribe } from "./calibration";

const RULES = gameConfig.playerGenerationRules;

function worldWithClubs(count: number, playersPerClub = 0): World {
  const clubs: Club[] = [];
  const players: Player[] = [];
  let nextId = 1000;
  for (let i = 1; i <= count; i++) {
    clubs.push(makeClub({ id: i, ownerUserId: i, isHuman: true, competitionState: "ACTIVE" }));
    for (let j = 0; j < playersPerClub; j++) {
      const player = generatePlayer(createRng(nextId), clubs[i - 1], { id: nextId++ });
      player.age = 24;
      players.push(player);
    }
  }
  const world = makeWorld(clubs, players);
  world.nextId = nextId + 1;
  return world;
}

describe("active population boundary", () => {
  it("counts only active persistent clubs and free agents inside retention", () => {
    const active = makeClub({ id: 1, ownerUserId: 1, isHuman: true, competitionState: "ACTIVE" });
    const dormant = makeClub({ id: 2, ownerUserId: 2, isHuman: true, competitionState: "DORMANT" });
    const provisional = makeClub({ id: 3, ownerUserId: 3, isHuman: true, competitionState: "PROVISIONAL" });
    const filler = makeClub({ id: 4, ownerUserId: null, isHuman: false, competitionState: "ACTIVE" });
    expect(isActivePersistentClub(active)).toBe(true);
    expect(isActivePersistentClub(dormant)).toBe(false);
    expect(isActivePersistentClub(provisional)).toBe(false);
    expect(isActivePersistentClub(filler)).toBe(false);

    const players = [1, 2, 3, 4].map((clubId, index) => {
      const player = generatePlayer(createRng(index + 1), active, { id: 100 + index });
      player.clubId = clubId;
      return player;
    });
    const world = makeWorld([active, dormant, provisional, filler], players);
    // Only the one owned by the active persistent club is inside the boundary.
    expect(activePopulation(world).owned).toBe(1);
  });

  it("includes the derived free-agent pool in the target, not as an untracked surplus", () => {
    const clubs = 10;
    const owned = RULES.targetOwnedPlayersPerActiveClub * clubs;
    expect(targetFreeAgentPool(clubs)).toBeGreaterThan(0);
    expect(targetActivePopulation(clubs)).toBeCloseTo(owned + targetFreeAgentPool(clubs), 9);
  });
});

describe("structural population flows", () => {
  it("adds exactly one correction for a free agent deleted after retention", () => {
    const club = makeClub({ id: 1, ownerUserId: 1, isHuman: true });
    const player = generatePlayer(createRng(1), club, { id: 10 });
    player.clubId = null;
    const world = makeWorld([club], [player]);
    deleteUnclaimedFreeAgent(world, player.id, Date.now());
    expect(world.players).toHaveLength(0);
    expect(ensurePopulationLedger(world).eligibleTerminalDeletions).toBe(1);
    // The pending counter is incremented once, in the same step as the delete.
    expect(ensurePopulationLedger(world).cumulative.eligibleTerminalDeletions).toBe(1);
  });

  it("adds no correction for academy promotion", () => {
    const world = worldWithClubs(1);
    const youth = generateYouthPlayer({
      id: 500, clubId: 1, country: "BRA", position: 3 as Position, age: 19, isYouth: true,
      currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId: 1,
      generationType: "initial-academy", seed: 1, slot: 0,
    });
    world.players.push(youth);
    const before = { ...ensurePopulationLedger(world) };
    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);
    // Promotion reclassifies an existing active player: never a population flow.
    expect(youth.isYouth).toBe(false);
    expect(ensurePopulationLedger(world).cumulative.youthDismissals ?? 0).toBe(before.cumulative.youthDismissals ?? 0);
  });

  it("subtracts non-academy persistent generation from the correction", () => {
    const world = worldWithClubs(1);
    recordExtraNonAcademyGeneration(world, 3, "seniorFloorReplacements");
    expect(ensurePopulationLedger(world).extraNonAcademyGeneration).toBe(3);
    const withReplacements = planSeasonalIntake(world, 1).rawExpectedGlobalIntake;
    ensurePopulationLedger(world).extraNonAcademyGeneration = 0;
    const without = planSeasonalIntake(world, 1).rawExpectedGlobalIntake;
    expect(withReplacements).toBeCloseTo(without - 3, 9);
  });

  it("adds no correction for a dormant freeze, because target and stock leave together", () => {
    const world = worldWithClubs(2, 5);
    const before = planSeasonalIntake(world, 1);
    world.clubs[1].competitionState = "DORMANT";
    const after = planSeasonalIntake(world, 1);
    // One fewer active club removes exactly one club's baseline share; no
    // destruction correction is added on top of that.
    expect(after.eligibleClubIds).toHaveLength(1);
    expect(before.rawExpectedGlobalIntake - after.rawExpectedGlobalIntake)
      .toBeCloseTo(before.rawExpectedGlobalIntake / 2, 6);
  });

  it("records the signed gap when a club joins or returns to the active boundary", () => {
    const world = worldWithClubs(1);
    // A club arriving with fewer players than the target leaves a positive gap.
    recordActiveClubBoundaryChange(world, RULES.targetOwnedPlayersPerActiveClub - 8, 1);
    expect(ensurePopulationLedger(world).activeClubPopulationGap).toBe(8);
    // A club arriving with more than the target reduces the next intake.
    recordActiveClubBoundaryChange(world, RULES.targetOwnedPlayersPerActiveClub + 3, 1);
    expect(ensurePopulationLedger(world).activeClubPopulationGap).toBe(5);
  });
});

describe("youth dismissal compensation", () => {
  it("accounts for the previous season's dismissed youths at the next seasonal intake", () => {
    const world = worldWithClubs(4, 2);
    world.mp.seasonId = 5;
    // The intake that opens season 6 must replenish season 5's drain.
    const before = planSeasonalIntake(world, 6);
    recordYouthDismissal(world, 3);
    const after = planSeasonalIntake(world, 6);
    expect(after.maturedYouthDismissals).toBe(3);
    expect(after.rawExpectedGlobalIntake).toBeCloseTo(before.rawExpectedGlobalIntake + 3, 9);
    expect(after.resolvedGlobalIntake).toBeGreaterThan(before.resolvedGlobalIntake);
    expect(pendingYouthDismissalCount(world)).toBe(3);
  });

  it("keeps a dismissal pending until an intake converts it, then consumes it exactly once", () => {
    const world = worldWithClubs(4, 2);
    world.mp.seasonId = 5;
    recordYouthDismissal(world, 2);
    // Planning under the dismissal's own season id sees nothing yet: intakes
    // run under the NEW season id, so this is the predicate's boundary case.
    expect(planSeasonalIntake(world, 5).maturedYouthDismissals).toBe(0);
    const plan = planSeasonalIntake(world, 6);
    expect(plan.maturedYouthDismissals).toBe(2);
    commitSeasonalIntake(world, 6, plan, plan.resolvedGlobalIntake);
    expect(pendingYouthDismissalCount(world)).toBe(0);
    // A later intake cannot convert the same dismissal a second time.
    expect(planSeasonalIntake(world, 7).maturedYouthDismissals).toBe(0);
    expect(ensurePopulationLedger(world).maturedYouthDismissals).toBe(2);
  });

  it("converts every pending dismissal at the intake regardless of which season recorded it", () => {
    const world = worldWithClubs(4, 2);
    const ledger = ensurePopulationLedger(world);
    ledger.pendingYouthDismissals.push({ seasonId: 3, count: 1 }, { seasonId: 6, count: 4 });
    const plan = planSeasonalIntake(world, 7);
    expect(plan.maturedYouthDismissals).toBe(5);
    commitSeasonalIntake(world, 7, plan, plan.resolvedGlobalIntake);
    expect(pendingYouthDismissalCount(world)).toBe(0);
    expect(ledger.maturedYouthDismissals).toBe(5);
  });

  it("gives the dismissing club no targeted reroll through the live dismissal path", () => {
    const world = worldWithClubs(4, 2);
    world.mp.seasonId = 5;
    const youth = generateYouthPlayer({
      id: 900, clubId: 1, country: "BRA", position: 3 as Position, age: 17, isYouth: true,
      currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId: 1,
      generationType: "initial-academy", seed: 5, slot: 0,
    });
    world.players.push(youth);
    const before = planSeasonalIntake(world, 6);
    expect(dismissYouthPlayer(world, youth).ok).toBe(true);
    const after = planSeasonalIntake(world, 6);
    // The loss feeds the GLOBAL pool: the total rises by exactly one player,
    // and the shared seeded split distributes it. No single club may gain more
    // than one slot, and every gain goes through the same allocation as
    // everyone else — never a personal reroll entitlement.
    expect(after.rawExpectedGlobalIntake).toBeCloseTo(before.rawExpectedGlobalIntake + 1, 9);
    const delta = (clubId: number) => allocatedIntakeForClub(after, clubId) - allocatedIntakeForClub(before, clubId);
    let gainedTotal = 0;
    for (const club of world.clubs) {
      expect(delta(club.id)).toBeGreaterThanOrEqual(0);
      expect(delta(club.id)).toBeLessThanOrEqual(1);
      gainedTotal += delta(club.id);
    }
    expect(gainedTotal).toBe(after.resolvedGlobalIntake - before.resolvedGlobalIntake);
  });
});

describe("signed correction and minimum intake", () => {
  it("guarantees the configured minimum intake even during a surplus", () => {
    const world = worldWithClubs(10, 2);
    // A large negative correction: far more stock than the target calls for.
    ensurePopulationLedger(world).carriedCorrection = -500;
    const plan = planSeasonalIntake(world, 3);
    expect(plan.rawExpectedGlobalIntake).toBeLessThan(0);
    expect(plan.minimumGlobalIntake).toBe(Math.ceil(RULES.minimumAcademyIntakePerActiveClub * 10));
    expect(plan.resolvedGlobalIntake).toBe(plan.minimumGlobalIntake);
    // The unserved negative balance is carried, not silently discarded.
    expect(plan.carryBeforeAllocation).toBeLessThan(0);
  });

  it("carries the remaining negative balance forward across commits", () => {
    const world = worldWithClubs(10, 2);
    ensurePopulationLedger(world).carriedCorrection = -500;
    const plan = planSeasonalIntake(world, 3);
    commitSeasonalIntake(world, 3, plan, plan.resolvedGlobalIntake);
    expect(ensurePopulationLedger(world).carriedCorrection).toBeCloseTo(plan.carryBeforeAllocation, 9);
    expect(ensurePopulationLedger(world).carriedCorrection).toBeLessThan(0);
  });

  it("carries blocked academy slots forward rather than rerolling or losing them", () => {
    const world = worldWithClubs(10, 2);
    const plan = planSeasonalIntake(world, 4);
    expect(plan.resolvedGlobalIntake).toBeGreaterThan(0);
    // Half the resolved intake was blocked by full academies.
    const generated = Math.floor(plan.resolvedGlobalIntake / 2);
    commitSeasonalIntake(world, 4, plan, generated);
    const blocked = plan.resolvedGlobalIntake - generated;
    expect(ensurePopulationLedger(world).carriedCorrection)
      .toBeCloseTo(plan.carryBeforeAllocation + blocked, 9);
    expect(ensurePopulationLedger(world).cumulative.academyIntakeBlocked).toBe(blocked);
  });

  it("consumes every pending counter exactly once on commit", () => {
    const world = worldWithClubs(5, 2);
    recordTerminalDeletion(world, 4);
    recordExtraNonAcademyGeneration(world, 1, "seniorFloorReplacements");
    const plan = planSeasonalIntake(world, 8);
    commitSeasonalIntake(world, 8, plan, plan.resolvedGlobalIntake);
    const ledger = ensurePopulationLedger(world);
    expect(ledger.eligibleTerminalDeletions).toBe(0);
    expect(ledger.extraNonAcademyGeneration).toBe(0);
    expect(ledger.activeClubPopulationGap).toBe(0);
    expect(ledger.actualEligibleRetirements).toBe(0);
    // A retried plan for the same season cannot re-consume the same deletions.
    const retried = planSeasonalIntake(world, 8);
    expect(retried.rawExpectedGlobalIntake).toBeLessThan(plan.rawExpectedGlobalIntake);
  });
});

describe("exact seeded-random global allocation", () => {
  it("gives ten clubs 21 players as two each plus exactly one remainder recipient", () => {
    const world = worldWithClubs(10, 2);
    const plan = planSeasonalIntake(world, 12);
    // Force the documented worked example: 21 across 10 clubs -> average 2.1.
    const forced = { ...plan, resolvedGlobalIntake: 21, basePerClub: 2, remainderRecipients: plan.remainderRecipients.slice(0, 1) };
    const total = forced.eligibleClubIds.reduce((sum, id) => sum + allocatedIntakeForClub(forced, id), 0);
    expect(forced.basePerClub).toBe(2);
    expect(forced.remainderRecipients).toHaveLength(1);
    expect(total).toBe(21);
  });

  it("distributes exactly the resolved total and never more than one remainder each", () => {
    for (const clubCount of [1, 3, 7, 10, 16]) {
      const world = worldWithClubs(clubCount, 2);
      const plan = planSeasonalIntake(world, 20);
      const total = plan.eligibleClubIds.reduce((sum, id) => sum + allocatedIntakeForClub(plan, id), 0);
      expect(total, `clubCount=${clubCount}`).toBe(plan.resolvedGlobalIntake);
      expect(new Set(plan.remainderRecipients).size).toBe(plan.remainderRecipients.length);
      expect(plan.remainderRecipients.length).toBeLessThan(Math.max(1, clubCount));
    }
  });

  it("is reproducible for the same seed, season and key", () => {
    const a = planSeasonalIntake(worldWithClubs(9, 2), 33);
    const b = planSeasonalIntake(worldWithClubs(9, 2), 33);
    expect(a.remainderRecipients).toEqual(b.remainderRecipients);
    expect(a.resolvedGlobalIntake).toBe(b.resolvedGlobalIntake);
  });

  it("is independent of club processing order", () => {
    const world = worldWithClubs(9, 2);
    const forward = planSeasonalIntake(world, 34);
    world.clubs.reverse();
    world.players.reverse();
    const reversed = planSeasonalIntake(world, 34);
    expect(reversed.remainderRecipients).toEqual(forward.remainderRecipients);
    expect(reversed.eligibleClubIds).toEqual(forward.eligibleClubIds);
  });

  it("varies the recipients across seasons", () => {
    const world = worldWithClubs(12, 2);
    const seasons = [1, 2, 3, 4, 5].map((seasonId) => planSeasonalIntake(world, seasonId).remainderRecipients.join(","));
    expect(new Set(seasons).size).toBeGreaterThan(1);
  });

  it("records the seeded allocation for later reproducibility audits", () => {
    const world = worldWithClubs(8, 2);
    const plan = planSeasonalIntake(world, 41);
    commitSeasonalIntake(world, 41, plan, plan.resolvedGlobalIntake);
    const recorded = ensurePopulationLedger(world).lastAllocation!;
    expect(recorded.seasonId).toBe(41);
    expect(recorded.resolvedGlobalIntake).toBe(plan.resolvedGlobalIntake);
    expect(recorded.remainderRecipients).toEqual(plan.remainderRecipients);
  });
});

describe("atomic flow accounting", () => {
  it("never generates a player before the seasonal intake boundary", () => {
    const world = worldWithClubs(3, 2);
    const before = world.players.length;
    recordTerminalDeletion(world, 5);
    recordYouthDismissal(world, 2);
    recordActiveClubBoundaryChange(world, 10, 1);
    recordExtraNonAcademyGeneration(world, 1, "seniorFloorReplacements");
    // Recording a flow only moves counters; nothing is created.
    expect(world.players.length).toBe(before);
  });

  it("does not double-generate when the intake step is retried for the same season", () => {
    const world = generateWorld(4242);
    const club = makeClub({ id: 1, ownerUserId: 1, isHuman: true, competitionState: "ACTIVE" });
    world.clubs.push(club);
    world.mp.seasonId = 3;
    for (let i = 0; i < 22; i++) {
      const player = generatePlayer(createRng(500 + i), club, { id: world.nextId++ });
      player.age = 24;
      world.players.push(player);
    }
    processSeasonalAcademyIntake(world.rng, world);
    const after = world.players.length;
    processSeasonalAcademyIntake(world.rng, world);
    expect(world.players.length).toBe(after);
  });
});

describe("dormant club freeze", () => {
  it("does not age, retire, or elapse contracts for a dormant club's players", () => {
    const active = makeClub({ id: 1, ownerUserId: 1, isHuman: true, competitionState: "ACTIVE" });
    const dormant = makeClub({ id: 2, ownerUserId: 2, isHuman: true, competitionState: "DORMANT" });
    const frozen = generatePlayer(createRng(1), dormant, { id: 10 });
    frozen.clubId = dormant.id;
    frozen.age = 37;
    frozen.contractDays = gameConfig.seasonDays * 3;
    const running = generatePlayer(createRng(2), active, { id: 11 });
    running.clubId = active.id;
    running.age = 24;
    running.contractDays = gameConfig.seasonDays * 3;
    const world = makeWorld([active, dormant], [frozen, running]);

    const before = { age: frozen.age, contractDays: frozen.contractDays, salary: frozen.salary, skills: { ...frozen.skills } };
    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);

    // A 37-year-old would very likely have retired had he been processed.
    expect(world.players.some((p) => p.id === frozen.id)).toBe(true);
    expect(frozen.age).toBe(before.age);
    expect(frozen.contractDays).toBe(before.contractDays);
    expect(frozen.salary).toBe(before.salary);
    expect(frozen.skills).toEqual(before.skills);
    // Meanwhile the active club's player advances normally.
    expect(running.age).toBe(25);
    expect(running.contractDays).toBe(gameConfig.seasonDays * 2);
  });

  it("gives a dormant club no academy intake, promotion, or replacement players", () => {
    const dormant = makeClub({ id: 2, ownerUserId: 2, isHuman: true, competitionState: "DORMANT" });
    const youth = generateYouthPlayer({
      id: 700, clubId: dormant.id, country: "BRA", position: 3 as Position, age: 19, isYouth: true,
      currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId: 1,
      generationType: "initial-academy", seed: 9, slot: 0,
    });
    const world = makeWorld([dormant], [youth]);
    const before = world.players.length;

    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);

    // No intake, no age promotion (he did not age), and no senior-floor top-up
    // despite the squad being far below the floor.
    expect(world.players.length).toBe(before);
    expect(youth.isYouth).toBe(true);
    expect(youth.age).toBe(19);
  });
});

calibrationDescribe("long-run population stability", () => {
  it("keeps the active population near its target across many seeded seasons", () => {
    const seeds = [11, 22, 33, 44, 55];
    const slopes: number[] = [];
    for (const seed of seeds) {
      const world = worldWithClubs(8, 30);
      world.seed = seed;
      const stock: number[] = [];
      for (let season = 1; season <= 40; season++) {
        world.mp.seasonId = season;
        processSeasonEndContracts(world.rng, world);
        processSeasonalAcademyIntake(world.rng, world);
        stock.push(activePopulation(world).total);
      }
      // Least-squares slope of the stock over the simulated seasons.
      const n = stock.length;
      const meanX = (n - 1) / 2;
      const meanY = stock.reduce((sum, value) => sum + value, 0) / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        num += (i - meanX) * (stock[i] - meanY);
        den += (i - meanX) ** 2;
      }
      slopes.push(num / den);
    }
    const meanSlope = slopes.reduce((sum, value) => sum + value, 0) / slopes.length;
    // No systematic drain or inflation: the per-season slope must stay small
    // relative to one club's worth of players.
    expect(Math.abs(meanSlope)).toBeLessThan(2);
  });

  it("distributes remainder recipients approximately uniformly across seasons", () => {
    const world = worldWithClubs(10, 2);
    const counts = new Map<number, number>();
    const seasons = 4_000;
    for (let seasonId = 1; seasonId <= seasons; seasonId++) {
      for (const clubId of planSeasonalIntake(world, seasonId).remainderRecipients) {
        counts.set(clubId, (counts.get(clubId) ?? 0) + 1);
      }
    }
    const totals = [...counts.values()];
    const expected = totals.reduce((sum, value) => sum + value, 0) / 10;
    // A binomial confidence band, not strict rotation: repeated recipients
    // across seasons are a valid outcome of the seeded-random policy.
    for (const total of totals) {
      expect(Math.abs(total - expected) / expected).toBeLessThan(0.25);
    }
  });
});
