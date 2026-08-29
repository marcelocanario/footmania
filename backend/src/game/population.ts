import type { Club, PopulationLedger, World } from "./types";
import { shuffle } from "./rng";
import { isEphemeralAI } from "./club";
import { expectedActivePlayerLifetimeFromAcademyEntry, retirementProbability } from "./careerCurves";
import { academyPositionWeights, playerRng } from "./playerGeneration";
import { gameConfig } from "../config";

/**
 * Persistent-population control.
 *
 * The world keeps a signed, durable ledger of every structural population
 * event. Terminal events only INCREMENT a pending counter, in the same
 * transaction that performs the deletion. The single seasonal academy intake at
 * the season boundary is the only step that converts pending compensation into
 * new players, so a retry can never generate a second cohort from the same
 * deletion.
 *
 * Boundary rules that keep the ledger honest:
 *   - filler AI, provisional teams and their players are entirely outside it;
 *   - a club going dormant removes its target contribution AND its frozen stock
 *     together, so it is a boundary change, not destruction;
 *   - academy promotion only reclassifies an existing player: never a flow;
 *   - transfers, signings and loans change ownership, not population.
 */

export function emptyPopulationLedger(): PopulationLedger {
  return {
    carriedCorrection: 0,
    actualEligibleRetirements: 0,
    expectedEligibleRetirements: 0,
    eligibleTerminalDeletions: 0,
    pendingYouthDismissals: [],
    maturedYouthDismissals: 0,
    extraNonAcademyGeneration: 0,
    activeClubPopulationGap: 0,
    cumulative: {},
    lastAllocation: null,
  };
}

export function ensurePopulationLedger(world: World): PopulationLedger {
  world.mp.population ??= emptyPopulationLedger();
  const ledger = world.mp.population;
  ledger.pendingYouthDismissals ??= [];
  ledger.cumulative ??= {};
  return ledger;
}

function addCumulative(ledger: PopulationLedger, cause: string, amount: number): void {
  ledger.cumulative[cause] = (ledger.cumulative[cause] ?? 0) + amount;
}

// ---------------------------------------------------------------------------
// Active population boundary and target (§9.1)
// ---------------------------------------------------------------------------

/**
 * A club inside the active persistent boundary. Ephemeral filler AI never is;
 * a dormant or provisional club is outside it along with all of its players.
 */
export function isActivePersistentClub(club: Club): boolean {
  return !isEphemeralAI(club) && (club.competitionState ?? "ACTIVE") === "ACTIVE";
}

export function activePersistentClubs(world: World): Club[] {
  return world.clubs.filter(isActivePersistentClub);
}

/** Owned players plus professional free agents inside their retention period. */
export function activePopulation(world: World): { owned: number; freeAgents: number; total: number } {
  const activeIds = new Set(activePersistentClubs(world).map((club) => club.id));
  const owned = world.players.filter((p) => p.clubId !== null && activeIds.has(p.clubId)).length;
  const listedFreeAgents = new Set(
    world.freeAgentListings.filter((listing) => listing.status === "ACTIVE").map((listing) => listing.playerId),
  );
  const freeAgents = world.players.filter((p) => p.clubId === null && !p.isYouth && listedFreeAgents.has(p.id)).length;
  return { owned, freeAgents, total: owned + freeAgents };
}

/**
 * Target free-agent stock, derived from expiry flow, signing probability, and
 * retention duration: stock = flow × average residence time.
 */
export function targetFreeAgentPool(activeClubCount: number): number {
  const pool = gameConfig.freeAgentPool;
  const retentionSeasons = gameConfig.freeAgentRetentionDays / gameConfig.seasonDays;
  const residence = (1 - pool.signingProbability) * retentionSeasons + pool.signingProbability * pool.signedResidenceSeasons;
  return activeClubCount * pool.expectedExpiriesPerActiveClubPerSeason * residence;
}

export function targetActivePopulation(activeClubCount: number): number {
  return gameConfig.playerGenerationRules.targetOwnedPlayersPerActiveClub * activeClubCount + targetFreeAgentPool(activeClubCount);
}

// ---------------------------------------------------------------------------
// Baseline and retirement variance (§9.2)
// ---------------------------------------------------------------------------

/**
 * Smooth expected intake per club per season: one recruit replaces one
 * population slot over the full academy-to-terminal-drain lifetime.
 */
export function retirementBaselinePerClub(): number {
  const lifetime = expectedActivePlayerLifetimeFromAcademyEntry(academyPositionWeights());
  if (lifetime <= 0) return 0;
  return gameConfig.playerGenerationRules.targetOwnedPlayersPerActiveClub / lifetime;
}

/**
 * Expected retirements among the players who are actually eligible to retire.
 * Call this AFTER season-end aging and before the retirement rolls, so the ages
 * match the ones the rolls will see. Compared against the realized count so an
 * unusually high-retirement season is fully replenished and an unusually low one
 * creates no permanent surplus.
 */
export function expectedEligibleRetirements(world: World): number {
  const activeIds = new Set(activePersistentClubs(world).map((club) => club.id));
  return world.players
    .filter((p) => p.clubId !== null && activeIds.has(p.clubId) && !p.isYouth)
    .reduce((sum, p) => sum + retirementProbability(p.age, p.position), 0);
}

// ---------------------------------------------------------------------------
// Durable flow recording (§9.5) — counters only, never immediate generation
// ---------------------------------------------------------------------------

export function recordRetirementOutcome(world: World, actual: number, expected: number): void {
  const ledger = ensurePopulationLedger(world);
  ledger.actualEligibleRetirements += actual;
  ledger.expectedEligibleRetirements += expected;
  addCumulative(ledger, "actualEligibleRetirements", actual);
  addCumulative(ledger, "expectedEligibleRetirements", expected);
}

/** A free agent deleted after his retention period: a real, compensable loss. */
export function recordTerminalDeletion(world: World, count = 1): void {
  const ledger = ensurePopulationLedger(world);
  ledger.eligibleTerminalDeletions += count;
  addCumulative(ledger, "eligibleTerminalDeletions", count);
}

/**
 * A youth dismissal. It creates no credit for the dismissing club and no
 * targeted replacement: it adds one to the GLOBAL correction at the first
 * seasonal intake after the drain — the intake that opens the following
 * season — so a club can never dismiss and reroll while the world still does
 * not shrink.
 */
export function recordYouthDismissal(world: World, count = 1): void {
  const ledger = ensurePopulationLedger(world);
  const seasonId = world.mp.seasonId;
  const existing = ledger.pendingYouthDismissals.find((entry) => entry.seasonId === seasonId);
  if (existing) existing.count += count;
  else ledger.pendingYouthDismissals.push({ seasonId, count });
  addCumulative(ledger, "youthDismissals", count);
}

/** Persistent players created outside academy intake reduce the correction. */
export function recordExtraNonAcademyGeneration(world: World, count: number, cause: string): void {
  if (count <= 0) return;
  const ledger = ensurePopulationLedger(world);
  ledger.extraNonAcademyGeneration += count;
  addCumulative(ledger, cause, count);
}

/**
 * A genuinely new or reactivated active club: its target contribution minus the
 * eligible stock that enters the boundary with it. A dormant transition is zero
 * because both leave together; provisional creation/destruction is always zero.
 */
export function recordActiveClubBoundaryChange(world: World, arrivingPlayers: number, direction: 1 | -1): void {
  const ledger = ensurePopulationLedger(world);
  const gap = direction * (gameConfig.playerGenerationRules.targetOwnedPlayersPerActiveClub - arrivingPlayers);
  ledger.activeClubPopulationGap += gap;
  addCumulative(ledger, "activeClubPopulationGap", gap);
}

// ---------------------------------------------------------------------------
// Signed correction, minimum intake, and seeded allocation (§9.3 / §9.4)
// ---------------------------------------------------------------------------

export interface IntakePlan {
  eligibleClubIds: number[];
  rawExpectedGlobalIntake: number;
  minimumGlobalIntake: number;
  resolvedGlobalIntake: number;
  /** Base players every eligible club receives. */
  basePerClub: number;
  /** Clubs receiving one additional player, in seeded order. */
  remainderRecipients: number[];
  /** Dismissed youths of completed seasons converted by this cycle. */
  maturedYouthDismissals: number;
  /** Retirement variance folded into the raw total. */
  retirementVarianceCorrection: number;
  /** Signed balance that will carry forward if nothing else changes. */
  carryBeforeAllocation: number;
}

/**
 * Resolve the exact global integer intake total and its per-club allocation.
 *
 * Because players are indivisible, an average of 2.1 across ten clubs is two
 * each plus exactly one seeded remainder recipient — not a per-club coin flip,
 * which would let the realized total drift away from the resolved figure.
 */
export function planSeasonalIntake(world: World, seasonId: number): IntakePlan {
  const ledger = ensurePopulationLedger(world);
  const rules = gameConfig.playerGenerationRules;
  const eligibleClubIds = activePersistentClubs(world).map((club) => club.id).sort((a, b) => a - b);
  const clubCount = eligibleClubIds.length;

  const matured = ledger.pendingYouthDismissals
    // Intakes run under the NEW season id (the rollover advances mp.seasonId
    // before this step), so diff >= 1 means "dismissed during a COMPLETED
    // season": the first intake of the following season accounts for last
    // season's drain.
    .filter((entry) => seasonId - entry.seasonId >= 1)
    .reduce((sum, entry) => sum + entry.count, 0);
  const retirementVarianceCorrection = ledger.actualEligibleRetirements - ledger.expectedEligibleRetirements;

  const rawExpectedGlobalIntake =
    retirementBaselinePerClub() * clubCount
    + ledger.carriedCorrection
    + retirementVarianceCorrection
    + ledger.eligibleTerminalDeletions
    + matured
    - ledger.extraNonAcademyGeneration
    + ledger.activeClubPopulationGap;

  const minimumGlobalIntake = Math.ceil(rules.minimumAcademyIntakePerActiveClub * clubCount);
  const resolvedGlobalIntake = Math.max(minimumGlobalIntake, Math.max(0, Math.round(rawExpectedGlobalIntake)));

  const basePerClub = clubCount > 0 ? Math.floor(resolvedGlobalIntake / clubCount) : 0;
  const remainderSlots = clubCount > 0 ? resolvedGlobalIntake - basePerClub * clubCount : 0;
  const rng = playerRng(world.seed, 0, "academy-intake-allocation", 0, seasonId);
  const shuffled = shuffle(rng, eligibleClubIds);
  const remainderRecipients = shuffled.slice(0, remainderSlots);

  return {
    eligibleClubIds,
    rawExpectedGlobalIntake,
    minimumGlobalIntake,
    resolvedGlobalIntake,
    basePerClub,
    remainderRecipients,
    maturedYouthDismissals: matured,
    retirementVarianceCorrection,
    carryBeforeAllocation: rawExpectedGlobalIntake - resolvedGlobalIntake,
  };
}

/** Players allocated to one club by a resolved plan. */
export function allocatedIntakeForClub(plan: IntakePlan, clubId: number): number {
  if (!plan.eligibleClubIds.includes(clubId)) return 0;
  return plan.basePerClub + (plan.remainderRecipients.includes(clubId) ? 1 : 0);
}

/**
 * Consume the pending counters and record the signed carry. Called exactly once
 * per intake, in the same locked commit that generates the players and marks the
 * idempotency key, so a retry sees either all of these effects or none.
 *
 * `actuallyGenerated` may be below the resolved total when academies were full:
 * those blocked slots carry forward rather than rerolling or disappearing.
 */
export function commitSeasonalIntake(world: World, seasonId: number, plan: IntakePlan, actuallyGenerated: number): void {
  const ledger = ensurePopulationLedger(world);
  const blocked = plan.resolvedGlobalIntake - actuallyGenerated;
  ledger.carriedCorrection = plan.carryBeforeAllocation + blocked;
  // Every pending dismissal matured into this plan (diff >= 1 covers all of
  // them), so the commit consumes the whole list exactly once.
  ledger.pendingYouthDismissals = [];
  ledger.maturedYouthDismissals += plan.maturedYouthDismissals;
  ledger.actualEligibleRetirements = 0;
  ledger.expectedEligibleRetirements = 0;
  ledger.eligibleTerminalDeletions = 0;
  ledger.extraNonAcademyGeneration = 0;
  ledger.activeClubPopulationGap = 0;
  ledger.lastAllocation = {
    seasonId,
    resolvedGlobalIntake: plan.resolvedGlobalIntake,
    remainderRecipients: [...plan.remainderRecipients],
  };
  addCumulative(ledger, "academyIntakeGenerated", actuallyGenerated);
  addCumulative(ledger, "academyIntakeBlocked", blocked);
  addCumulative(ledger, "maturedYouthDismissals", plan.maturedYouthDismissals);
}

/** Dismissals recorded but not yet converted by a seasonal intake. */
export function pendingYouthDismissalCount(world: World): number {
  return ensurePopulationLedger(world).pendingYouthDismissals.reduce((sum, entry) => sum + entry.count, 0);
}
