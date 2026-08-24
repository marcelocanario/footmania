import type { Player, World } from "./types";
import { applyDevelopment } from "./player";
import { contractCycle, settlePayroll, weeklyUpdate } from "./season";
import { gameConfig } from "../config";
import { evaluateInactivity } from "./multiplayer";
import { runFinancialIntervention } from "./finance";
import { isEphemeralAI } from "./club";
import { nextDouble } from "./rng";
import { calendarValues, roundForSeasonDayIndex } from "../services/seasonCalendar";
import { injuryDaysRemaining, loadFactor, ageFactor, recordInjury, recoverEnergy, recoveryCeiling, syncLegacyInjuryDays, ENERGY_INJURY_MODEL } from "./energyInjury";
import { NEWS_SUBJECTS, publishNews } from "./news";

/**
 * Authoritative game-day processing. The durable scheduler drives one
 * BEGIN_GAME_DAY / PAYROLL_RUN / WEEKLY_SIM_UPDATE triple per season day;
 * every entry point here is clock-based (season day indices) and never
 * consults a civil calendar.
 */

export const DAILY_TICK = "DAILY_TICK";
export const PAYROLL = "PAYROLL";
export const WEEKLY = "WEEKLY";

export interface DailyResult {
  /** execution types that actually ran for this date (for the ledger). */
  executed: string[];
}

function dailyDevelopment(world: World) {
  const squads = new Map<number, Player[]>();
  for (const p of world.players) {
    if (p.clubId === null) continue;
    let squad = squads.get(p.clubId);
    if (!squad) {
      squad = [];
      squads.set(p.clubId, squad);
    }
    squad.push(p);
  }
  for (const club of world.clubs) {
    const squad = squads.get(club.id);
    if (!squad) continue;
    for (const player of squad) applyDevelopment(world.rng, player, club, world.dayIndex);
  }
}

function poisson(rng: World["rng"], lambda: number): number {
  if (lambda <= 0) return 0;
  const threshold = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do { product *= nextDouble(rng); count++; } while (product > threshold);
  return count - 1;
}

function processTrainingInjuries(world: World, absoluteGameDay: number, seasonDayIndex: number): void {
  if (roundForSeasonDayIndex(seasonDayIndex) !== null) return;
  const calendar = calendarValues();
  const clubs = world.clubs.filter((club) => club.competitionState === "ACTIVE" || club.competitionState === undefined);
  for (const club of clubs) {
    const candidates = world.players.filter((player) => {
      if (player.clubId !== club.id || injuryDaysRemaining(player, absoluteGameDay) > 0) return false;
      return true;
    });
    if (candidates.length === 0) continue;
    // Reference risk from the versioned model, never duplicated literals.
    const reference = loadFactor(ENERGY_INJURY_MODEL.trainingInjuries.referenceRecentLoad)
      * ageFactor(ENERGY_INJURY_MODEL.injuryRisk.ageReference);
    const risks = candidates.map((player) => ({ player, risk: loadFactor(player.recentLoad ?? 0) * ageFactor(player.age) }));
    const meanRelativeRisk = risks.reduce((sum, item) => sum + item.risk, 0) / risks.length / reference;
    const eligibleDays = Math.max(1, calendar.seasonDays - calendar.roundsPerSeason);
    const events = poisson(world.rng, gameConfig.injuries.trainingTargetPerClubSeason / eligibleDays * meanRelativeRisk);
    const pool = risks.slice();
    const injured: Player[] = [];
    for (let i = 0; i < events && pool.length > 0; i++) {
      const total = pool.reduce((sum, item) => sum + item.risk, 0);
      let roll = nextDouble(world.rng) * total;
      let index = pool.length - 1;
      for (let j = 0; j < pool.length; j++) { roll -= pool[j].risk; if (roll <= 0) { index = j; break; } }
      const selected = pool.splice(index, 1)[0].player;
      recordInjury(world.rng, selected, "TRAINING", absoluteGameDay, calendar.roundsPerSeason, calendar.matchSpacingDays);
      injured.push(selected);
    }
    // One grouped dashboard message per club per day instead of one row per injury.
    if (injured.length > 0) {
      publishNews(world, {
        kind: "injury",
        subject: NEWS_SUBJECTS.injuries,
        recipientClubId: club.id,
        headline: "Treatment room update",
        entries: injured.map((player) => ({
          key: `injury:${player.id}`,
          label: player.name,
          detail: `${injuryDaysRemaining(player, absoluteGameDay)} days out with a training injury`,
        })),
      });
    }
  }
}

function dailyCondition(world: World, seasonDayIndex: number): void {
  const absoluteGameDay = world.mp.absoluteGameDay ?? world.dayIndex;
  const calendar = calendarValues();
  // One game-day of exponential workload decay; the half-life is the match
  // spacing scaled by the versioned model multiplier.
  const decay = Math.pow(2, -1 / (calendar.matchSpacingDays * ENERGY_INJURY_MODEL.energy.workloadHalfLifeMatchSpacingMultiplier));
  for (const player of world.players) {
    if (player.clubId === null) continue;
    player.recentLoad = Math.max(0, Math.min(6, (player.recentLoad ?? 0) * decay));
    const until = player.injuryUntilAbsoluteGameDay;
    const expired = until !== null && until !== undefined && absoluteGameDay > until;
    const ceiling = expired ? 100 : recoveryCeiling(player.injuryInitialGameDays ?? null, calendar.matchSpacingDays);
    player.energy = Math.round(recoverEnergy(player, player.recentLoad, calendar.matchSpacingDays, ceiling));
    if (expired) {
      player.injuryUntilAbsoluteGameDay = null;
      player.injuryInitialGameDays = null;
      player.injuryEquivalentRealDays = null;
      player.injuryCause = null;
    }
    syncLegacyInjuryDays(player, absoluteGameDay);
  }
  processTrainingInjuries(world, absoluteGameDay, seasonDayIndex);
}

/** Process one authoritative game day. Unlike the legacy date replay helper,
 * this function never consults a civil calendar or month length. */
export function processGameDay(world: World, seasonDayIndex: number, now = Date.now()): DailyResult {
  const result = processGameDayStart(world, seasonDayIndex, now);
  if ((seasonDayIndex + 1) % gameConfig.payrollIntervalDays === 0) {
    processGameDayPayroll(world, seasonDayIndex, now);
    result.executed.push(PAYROLL);
  }
  if ((seasonDayIndex + 1) % gameConfig.weeklyIntervalDays === 0) {
    processGameDayWeekly(world, seasonDayIndex);
    result.executed.push(WEEKLY);
  }
  return result;
}

/** Run daily systems that belong to the beginning of a game day. */
export function processGameDayStart(world: World, seasonDayIndex: number, now = Date.now()): DailyResult {
  if (seasonDayIndex < 0 || seasonDayIndex >= gameConfig.seasonDays) throw new Error(`Invalid season day index: ${seasonDayIndex}`);
  world.dayIndex = seasonDayIndex;
  world.dayOfWeek = ((world.mp.absoluteGameDay ?? seasonDayIndex) % 7 + 7) % 7;
  world.year = world.mp.seasonNumber ?? world.year;
  const executed: string[] = [DAILY_TICK];
  evaluateInactivity(world, now);
  dailyCondition(world, seasonDayIndex);
  dailyDevelopment(world);
  return { executed };
}

/** Run the payroll event for a game day, if that day is a payroll boundary. */
export function processGameDayPayroll(world: World, seasonDayIndex: number, now = Date.now()): void {
  const humanDay = seasonDayIndex + 1;
  if (humanDay % gameConfig.payrollIntervalDays !== 0) return;
  // Ephemeral AI clubs are financially inert (invariant #28): they never pay
  // wages and can never enter a financial intervention.
  const wasNegativeBeforePayroll = world.clubs.filter((club) => club.competitionState === "ACTIVE" && !isEphemeralAI(club) && club.cash < 0);
  // Payroll boundaries are human-readable days, while the engine index is
  // zero-based. This gives exactly five boundaries in a 35-day season.
  settlePayrollThroughForGameDay(world, humanDay);
  for (const club of world.clubs) {
    if (club.competitionState !== "ACTIVE" || isEphemeralAI(club)) continue;
    if (!wasNegativeBeforePayroll.some((candidate) => candidate.id === club.id) || club.cash >= 0) continue;
    runFinancialIntervention(world, club, { seasonId: world.mp.seasonId, payrollCycleId: seasonDayIndex, now });
  }
}

/** Run weekly-only systems for a game day, if that day is a weekly boundary. */
export function processGameDayWeekly(world: World, seasonDayIndex: number): void {
  if ((seasonDayIndex + 1) % gameConfig.weeklyIntervalDays !== 0) return;
  weeklyUpdate(world.rng, world);
  contractCycle(world.rng, world);
}

function settlePayrollThroughForGameDay(world: World, humanDay: number): void {
  // Keep the existing payroll implementation authoritative while supplying the
  // canonical one-based boundary for its cumulative rounding calculation.
  const originalDay = world.dayIndex;
  world.dayIndex = humanDay;
  settlePayroll(world.rng, world);
  world.dayIndex = originalDay;
}
