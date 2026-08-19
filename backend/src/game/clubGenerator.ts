import type { Club, Player, Position, World } from "./types";
import { shuffle } from "./rng";
import { generateSeniorPlayer, generateYouthPlayer, seniorRosterTemplate, playerRng, type GenerationType } from "./playerGeneration";
import { gameConfig } from "../config";

/**
 * Squad-level generation orchestration (plans/4. player-generation.md §70-§73).
 *
 * The canonical per-player formulas live in playerGeneration.ts; this module
 * only assembles them into full senior squads and academy cohorts using the
 * deterministic position templates and age cohorts from the spec. Human and AI
 * clubs share this module exactly.
 */

export interface GenerationContext {
  world: World;
  club: Club;
  /** Club's current division (1 = strongest) for the season being generated. */
  currentDivision: number;
  /** Highest-ever division reached by the club. */
  highestDivisionReached: number;
  /** Total number of divisions in the pyramid at generation time. */
  totalDivisions: number;
  /** The season the club is about to play (null before the first season exists). */
  seasonId: number | null;
}

/**
 * Return the weakest tier currently present in the relevant pyramid. The
 * player-generation formulas need the total pyramid depth, not the generated
 * club's own tier. During rollover the new season may be created before
 * world.mp.seasonId is switched, so callers can provide the season explicitly.
 */
export function totalDivisionsForGeneration(world: World, seasonId?: number): number {
  const targetSeasonId = seasonId ?? world.mp.seasonId;
  const divisions = world.competitions.filter(
    (competition) =>
      competition.kind === "division" &&
      competition.status !== "ARCHIVED" &&
      (targetSeasonId <= 0 || competition.seasonId === targetSeasonId),
  );
  return Math.max(1, ...divisions.map((competition) => competition.tier ?? 1));
}

function nextId(world: World): number {
  return world.nextId++;
}

/**
 * Deterministic youth academy position allocator (spec §71 step 15). Broad
 * position weights for academy squads keep every academy able to field a
 * balanced youth pool while preserving the subposition logic inside each group.
 */
export const ACADEMY_POSITION_WEIGHTS = [0.1, 0.28, 0.26, 0.22, 0.14];
const ACADEMY_POSITION_GROUPS: Position[] = [0, 1, 2, 3, 4];

function largestRemainder(weights: number[], total: number): number[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / weightSum) * total);
  const allocated = exact.map((x) => Math.floor(x));
  let remaining = total - allocated.reduce((a, b) => a + b, 0);
  const fractions = exact.map((x, i) => x - allocated[i]);
  const order = fractions.map((f, i) => i).sort((a, b) => fractions[b] - fractions[a]);
  for (let i = 0; i < remaining; i++) {
    allocated[order[i % order.length]] += 1;
  }
  return allocated;
}

/**
 * Build a deterministic position template for an academy cohort of `total`
 * youth. The template is stable for a given (clubId, generationType, count) so
 * a retry reproduces the same positions.
 */
export function academyPositionTemplate(world: World, clubId: number, generationType: string, total: number, seasonId: number | null = null): Position[] {
  const counts = largestRemainder(ACADEMY_POSITION_WEIGHTS, total);
  const template: Position[] = [];
  for (let i = 0; i < counts.length; i++) {
    for (let j = 0; j < counts[i]; j++) template.push(ACADEMY_POSITION_GROUPS[i]);
  }
  const rng = playerRng(world.seed, clubId, generationType, 999_001, seasonId);
  return shuffle(rng, template);
}

/**
 * Generate the fixed 28-senior squad (spec §70). Position slots follow the
 * canonical 10/32/32/26 template; captain = best GK, penalty taker = best FW.
 */
export function generateInitialSeniorSquad(ctx: GenerationContext): Player[] {
  const { world, club } = ctx;
  const template = seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize);
  const created: Player[] = [];
  for (let slot = 0; slot < template.length; slot++) {
    const player = generateSeniorPlayer({
      id: nextId(world),
      clubId: club.id,
      country: club.country,
      position: template[slot],
      isYouth: false,
      currentDivision: ctx.currentDivision,
      highestDivisionReached: ctx.highestDivisionReached,
      totalDivisions: ctx.totalDivisions,
      seasonId: ctx.seasonId,
      generationType: "initial-senior",
      seed: world.seed,
      slot,
    });
    created.push(player);
    world.players.push(player);
  }
  const gks = created.filter((p) => p.position === 0).sort((a, b) => b.overall - a.overall);
  if (gks.length > 0) club.captainId = gks[0].id;
  club.penaltyTakerId = created.filter((p) => p.position === 4).sort((a, b) => b.overall - a.overall)[0]?.id ?? gks[0]?.id ?? null;
  return created;
}

/**
 * Generate the initial 8-youth academy cohort (spec §72). Ages are assigned as
 * evenly as possible across 16..19 (2 per age) and shuffled deterministically
 * before generation.
 */
export function generateInitialAcademy(ctx: GenerationContext): Player[] {
  const { world, club } = ctx;
  const { academyMinAge, academyMaxAge, initialAcademySize } = gameConfig.playerGenerationRules;
  const ages: number[] = [];
  for (let i = 0; i < initialAcademySize; i++) {
    ages.push(academyMinAge + (i % (academyMaxAge - academyMinAge + 1)));
  }
  const shuffleRng = playerRng(world.seed, club.id, "initial-academy", 0);
  const shuffledAges = shuffle(shuffleRng, ages);
  const positions = academyPositionTemplate(world, club.id, "initial-academy", initialAcademySize);
  const created: Player[] = [];
  for (let slot = 0; slot < shuffledAges.length; slot++) {
    const player = generateYouthPlayer({
      id: nextId(world),
      clubId: club.id,
      country: club.country,
      position: positions[slot],
      age: shuffledAges[slot],
      isYouth: true,
      currentDivision: ctx.currentDivision,
      highestDivisionReached: ctx.highestDivisionReached,
      totalDivisions: ctx.totalDivisions,
      seasonId: ctx.seasonId,
      generationType: "initial-academy",
      seed: world.seed,
      slot,
    });
    created.push(player);
    world.players.push(player);
  }
  return created;
}

/**
 * Generate the fixed seasonal academy intake (spec §43/§73): up to
 * SEASONAL_ACADEMY_INTAKE new youth, subject to academy roster slots. Ages are
 * drawn uniformly from academyMinAge..academyMaxAge. The event marker is checked
 * and written here so direct callers are idempotent as well.
 */
export function generateSeasonalAcademyIntake(ctx: GenerationContext): Player[] {
  const { world, club } = ctx;
  if (ctx.seasonId !== null && academyIntakeDone(world, club.id, ctx.seasonId)) return [];
  const { academyRosterLimit, seasonalAcademyIntake } = gameConfig.playerGenerationRules;
  const juniorCount = world.players.filter((p) => p.clubId === club.id && p.isYouth).length;
  const availableSlots = Math.max(0, academyRosterLimit - juniorCount);
  const intakeCount = Math.min(seasonalAcademyIntake, availableSlots);
  const positions = academyPositionTemplate(world, club.id, "seasonal-academy", intakeCount, ctx.seasonId);
  const created: Player[] = [];
  for (let slot = 0; slot < intakeCount; slot++) {
    const player = generateYouthPlayer({
      id: nextId(world),
      clubId: club.id,
      country: club.country,
      position: positions[slot],
      isYouth: true,
      currentDivision: ctx.currentDivision,
      highestDivisionReached: ctx.highestDivisionReached,
      totalDivisions: ctx.totalDivisions,
      seasonId: ctx.seasonId,
      generationType: "seasonal-academy",
      seed: world.seed,
      slot,
    });
    created.push(player);
    world.players.push(player);
  }
  if (ctx.seasonId !== null) markAcademyIntakeDone(world, club.id, ctx.seasonId);
  return created;
}

/** Has this club already received its seasonal academy intake for `seasonId`? */
export function academyIntakeDone(world: World, clubId: number, seasonId: number): boolean {
  return world.generationEvents.includes(`academy-intake:${clubId}:${seasonId}`);
}

/** Mark the seasonal academy intake as committed for the club/season. */
export function markAcademyIntakeDone(world: World, clubId: number, seasonId: number): void {
  const key = `academy-intake:${clubId}:${seasonId}`;
  if (!world.generationEvents.includes(key)) world.generationEvents.push(key);
}

/**
 * Guarded helper: generate the senior + youth squads for a brand-new club
 * (spec §46). Generation is skipped when the club already owns players or a
 * creation event was already recorded, so a retry of club creation cannot
 * generate a second roster or consume fresh random draws.
 */
export function generateNewClubRoster(ctx: GenerationContext): { seniors: Player[]; youth: Player[] } {
  const creationKey = `club-creation:${ctx.club.id}`;
  const hasPlayers = ctx.world.players.some((p) => p.clubId === ctx.club.id);
  if (hasPlayers || ctx.world.generationEvents.includes(creationKey)) {
    return {
      seniors: ctx.world.players.filter((p) => p.clubId === ctx.club.id && !p.isYouth),
      youth: ctx.world.players.filter((p) => p.clubId === ctx.club.id && p.isYouth),
    };
  }
  const seniors = generateInitialSeniorSquad(ctx);
  const youth = generateInitialAcademy(ctx);
  if (!ctx.world.generationEvents.includes(creationKey)) ctx.world.generationEvents.push(creationKey);
  return { seniors, youth };
}

export type { GenerationType };
