import type { Club, Player, World } from "./types";
import { shuffle } from "./rng";
import {
  academyPositionWeights,
  allocateBroadGroupCounts,
  allocateSeededCounts,
  generateInitialAcademyPlayers,
  generateInitialSeniorPlayers,
  generateYouthPlayer,
  playerRng,
  type GeneratePlayerContext,
  type GenerationType,
} from "./playerGeneration";
import { gameConfig } from "../config";
import { adjustedTacticalRating } from "./outOfPosition";
import type { DeployedRole } from "./positions";
import { SENIOR_SQUAD_LIMIT } from "./constants";
import { assignInitialSquadNumbers } from "./squadNumbers";
import { bumpSkillsVersion } from "./skillsVersion";
import type { NaturalPosition, PositionGroup } from "./positions";
import { positionGroup } from "./positions";

export { academyPositionWeights };

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
 * Hierarchical position template (§11.3). Broad groups via
 * `allocateBroadGroupCounts` (initial/filler) or `allocateSeededCounts`
 * (seasonal academy); natural roles always via `allocateSeededCounts` with the
 * exact split seed key. Concatenates in canonical natural-position display
 * order. Initial senior/filler templates are not newly shuffled; academy
 * templates use their one existing deterministic shuffle.
 */
function positionTemplate(
  world: World,
  clubId: number,
  generationType: string,
  total: number,
  seasonId: number | null,
  groups: Record<PositionGroup, number>,
  withinGroup: Record<PositionGroup, Record<NaturalPosition, number>>,
  useSeededBroad: boolean,
): NaturalPosition[] {
  const groupOrder: PositionGroup[] = ["GK", "FB", "CB", "MF", "FW"];
  const displayOrder: NaturalPosition[] = ["GK", "LB", "RB", "CB", "DM", "AM", "LW", "RW", "ST"];
  const broad = useSeededBroad
    ? allocateSeededCounts(total, groups as Record<string, number>, `${world.seed}|${clubId}|${generationType}|${seasonId ?? "none"}|broad`)
    : allocateBroadGroupCounts(total, groups as Record<string, number>);
  const template: NaturalPosition[] = [];
  for (const group of groupOrder) {
    const count = broad[group];
    const split = allocateSeededCounts(count, withinGroup[group] as Record<string, number>, `${world.seed}|${clubId}|${generationType}|${seasonId ?? "none"}|split|${group}`);
    for (const role of displayOrder) {
      for (let i = 0; i < (split[role] ?? 0); i++) template.push(role);
    }
  }
  if (!useSeededBroad) {
    // Initial senior/filler templates are not newly shuffled; initial academy
    // keeps its one existing deterministic academy-template shuffle.
    if (generationType === "initial-academy") {
      const rng = playerRng(world.seed, clubId, generationType, 999_001, seasonId);
      return shuffle(rng, template);
    }
  }
  return template;
}

function positionMix(): {
  seniorGroups: Record<PositionGroup, number>;
  academyGroups: Record<PositionGroup, number>;
  withinGroup: Record<PositionGroup, Record<NaturalPosition, number>>;
} {
  const mix = (gameConfig as unknown as { playerGeneration?: { positionMix?: { seniorGroups?: Record<string, number>; academyGroups?: Record<string, number>; withinGroup?: Record<string, Record<string, number>> } } })?.playerGeneration?.positionMix;
  return {
    seniorGroups: (mix?.seniorGroups as Record<PositionGroup, number>) ?? { GK: 0.1, FB: 0.14, CB: 0.18, MF: 0.32, FW: 0.26 },
    academyGroups: (mix?.academyGroups as Record<PositionGroup, number>) ?? { GK: 0.1, FB: 0.28, CB: 0.26, MF: 0.22, FW: 0.14 },
    withinGroup: (mix?.withinGroup as Record<PositionGroup, Record<NaturalPosition, number>>) ?? {
      GK: { GK: 1 },
      FB: { LB: 0.5, RB: 0.5 },
      CB: { CB: 1 },
      MF: { DM: 0.5, AM: 0.5 },
      FW: { LW: 1 / 3, RW: 1 / 3, ST: 1 / 3 },
    },
  };
}

/**
 * Build a deterministic position template for an academy cohort of `total`
 * youth (§11.1/§11.3). The template is stable for a given
 * (clubId, generationType, count, seasonId) so a retry reproduces the same
 * positions.
 */
export function academyPositionTemplate(world: World, clubId: number, generationType: string, total: number, seasonId: number | null = null): NaturalPosition[] {
  const mix = positionMix();
  const seeded = generationType === "seasonal-academy";
  return positionTemplate(world, clubId, generationType, total, seasonId, mix.academyGroups, mix.withinGroup, seeded);
}

/**
 * Generate a senior squad (spec §70). Position slots follow the canonical
 * broad 10/14/18/32/26 template split into the nine natural positions (§11.3);
 * captain = best GK, penalty taker = best ST (else best adjusted ST among
 * outfielders, else GK).
 */
export function generateInitialSeniorSquad(ctx: GenerationContext, size: number = gameConfig.playerGenerationRules.initialSeniorSquadSize): Player[] {
  const { world, club } = ctx;
  const mix = positionMix();
  const template = positionTemplate(world, club.id, "initial-senior", size, ctx.seasonId, mix.seniorGroups, mix.withinGroup, false);
  // Allocate player IDs in template/slot order BEFORE generation so the batch
  // path keeps the same idempotent ID sequence as the per-player path.
  const ids = template.map(() => nextId(world));
  const contexts: GeneratePlayerContext[] = template.map((position, slot) => ({
    id: ids[slot],
    clubId: club.id,
    country: club.country,
    position,
    isYouth: false,
    currentDivision: ctx.currentDivision,
    highestDivisionReached: ctx.highestDivisionReached,
    totalDivisions: ctx.totalDivisions,
    seasonId: ctx.seasonId,
    generationType: "initial-senior",
    seed: world.seed,
    slot,
  }));
  // Squad-level conditioning preserves age/profile draws and career coherence,
  // then fits current OVR to the division-relative initial-club band.
  const created = generateInitialSeniorPlayers(contexts);
  for (const player of created) world.players.push(player);
  bumpSkillsVersion();
  const gks = created.filter((p) => p.position === "GK").sort((a, b) => b.overall - a.overall);
  if (gks.length > 0) club.captainId = gks[0].id;
  // §13.3: penalty taker = best adjusted ST rating among natural STs; if no ST,
  // best adjusted ST rating among all outfielders; if no outfielder, GK.
  const sts = created.filter((p) => p.position === "ST");
  const stScore = (p: Player): number => tacticalRatingForRole(p, "ST");
  const bestSt = sts.length > 0 ? sts.sort((a, b) => stScore(b) - stScore(a) || a.id - b.id)[0] : undefined;
  const bestOutfield = created.filter((p) => p.position !== "GK").sort((a, b) => stScore(b) - stScore(a) || a.id - b.id)[0];
  club.penaltyTakerId = bestSt?.id ?? bestOutfield?.id ?? gks[0]?.id ?? null;
  return created;
}

/** §7.1 adjusted role rating; ineligible pairings score below every legal one. */
function tacticalRatingForRole(p: Player, role: DeployedRole): number {
  return adjustedTacticalRating(p.skills, p.position, role) ?? -1;
}

/**
 * Generate the initial academy cohort (spec §72). Ages are assigned as evenly
 * as possible across academyMinAge..academyMaxAge and shuffled deterministically.
 * The batch conditions future personal peaks; current OVR still comes from each
 * prospect's age and full career path. Positions use the hierarchical template.
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
  // Allocate IDs before the batch so slot/ID/persistence order remains stable.
  const ids = shuffledAges.map(() => nextId(world));
  const contexts: GeneratePlayerContext[] = shuffledAges.map((age, slot) => ({
    id: ids[slot],
    clubId: club.id,
    country: club.country,
    position: positions[slot],
    age,
    isYouth: true,
    currentDivision: ctx.currentDivision,
    highestDivisionReached: ctx.highestDivisionReached,
    totalDivisions: ctx.totalDivisions,
    seasonId: ctx.seasonId,
    generationType: "initial-academy",
    seed: world.seed,
    slot,
  }));
  // Only the club-creation cohort is conditioned. Seasonal intake below keeps
  // calling the independent youth generator directly.
  const created = generateInitialAcademyPlayers(contexts);
  for (const player of created) world.players.push(player);
  bumpSkillsVersion();
  return created;
}

/**
 * Generate this club's share of the seasonal academy intake. The exact global
 * total and each club's allocation are resolved by the population module; this
 * function only clamps to the academy roster limit and creates the players.
 * Blocked slots are reported back so they carry into the signed correction
 * rather than rerolling or disappearing.
 */
export function generateSeasonalAcademyIntake(ctx: GenerationContext & { allocated: number }): Player[] {
  const { world, club } = ctx;
  if (ctx.seasonId !== null && academyIntakeDone(world, club.id, ctx.seasonId)) return [];
  const { academyRosterLimit } = gameConfig.playerGenerationRules;
  const juniorCount = world.players.filter((p) => p.clubId === club.id && p.isYouth).length;
  const availableSlots = Math.max(0, academyRosterLimit - juniorCount);
  const intakeCount = Math.max(0, Math.min(ctx.allocated, availableSlots));
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
  bumpSkillsVersion();
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
  // Squad numbers: random, with the GK rule (#1 best goalkeeper, #12 second).
  assignInitialSquadNumbers(ctx.world.rng, [...seniors, ...youth]);
  if (!ctx.world.generationEvents.includes(creationKey)) ctx.world.generationEvents.push(creationKey);
  return { seniors, youth };
}

/**
 * Generate the static filler-AI roster (invariant #28): exactly
 * SENIOR_SQUAD_LIMIT senior players and no academy. Ephemeral AI teams keep
 * this roster for their single season; nothing is ever promoted, released or
 * added. Guarded by the same club-creation idempotency key as human rosters.
 */
export function generateFillerRoster(ctx: GenerationContext): Player[] {
  const creationKey = `club-creation:${ctx.club.id}`;
  const hasPlayers = ctx.world.players.some((p) => p.clubId === ctx.club.id);
  if (hasPlayers || ctx.world.generationEvents.includes(creationKey)) {
    return ctx.world.players.filter((p) => p.clubId === ctx.club.id && !p.isYouth);
  }
  const seniors = generateInitialSeniorSquad(ctx, SENIOR_SQUAD_LIMIT);
  // Squad numbers: random, with the GK rule (#1 best goalkeeper, #12 second).
  assignInitialSquadNumbers(ctx.world.rng, seniors);
  if (!ctx.world.generationEvents.includes(creationKey)) ctx.world.generationEvents.push(creationKey);
  return seniors;
}

export type { GenerationType };
export { positionGroup };
