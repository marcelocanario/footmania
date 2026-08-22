import type { Club, Player, World } from "./types";
import { chance, nextInt } from "./rng";
import {
  aging,
  potentialGrowth,
  shouldRetire,
} from "./player";
import { DAYS_PER_YEAR } from "./constants";
import { gameConfig, scaleReferenceSeasonFlow } from "../config";
import { resetPayrollPeriod, settlePayrollThrough, settlePlayerPayroll } from "./payroll";
import {
  calculateBaseSalary,
  calculateContractDemand,
  calculatePlayerValue,
  calculateReleaseClause,
  remainingSeasons,
} from "./economy";
import { divisionForClub, lowestActiveTier } from "./multiplayer";
import { generateSeasonalAcademyIntake, academyIntakeDone, markAcademyIntakeDone } from "./clubGenerator";
import { generateSeniorPlayer } from "./playerGeneration";
import { prepareFreeAgentListing } from "./freeAgents";
import { playerHasActiveListing } from "./market";
import { isEphemeralAI } from "./club";

/** Add game-days without wrapping at a civil-month or season boundary. */
export function seasonEndDay(dayIndex: number, daysFromNow: number): number {
  return dayIndex + Math.max(0, daysFromNow);
}

export function calculateDivisionPrize(higherBudget: number, currentBudget: number, position: number, teamCount: number): number {
  if (position < 1 || teamCount < 1 || position > teamCount) return 0;
  const difference = Math.max(0, higherBudget - currentBudget);
  return Math.round(difference * ((teamCount - position + 1) / teamCount));
}

export function loanFitsContract(startDay: number, endDay: number, contractDays: number): boolean {
  return endDay > startDay && endDay - startDay <= contractDays;
}

export { SENIOR_SQUAD_LIMIT } from "./constants";
import { SENIOR_SQUAD_LIMIT } from "./constants";

export function fairSalaryForPlayer(player: Player): number {
  return calculateBaseSalary(player.overall, player.age);
}

export function promotedYouthSalary(player: Player): number {
  return Math.max(scaleReferenceSeasonFlow(gameConfig.salaryFloor), Math.round(fairSalaryForPlayer(player) * 0.8));
}

export function promoteYouthPlayer(world: World, player: Player, reason: "manual" | "age" = "manual"): { ok: boolean; error?: string } {
  const club = world.clubs.find((c) => c.id === player.clubId);
  if (!club || !player.isYouth) return { ok: false, error: "Player is not in the youth academy" };
  const seniorCount = world.players.filter((p) => p.clubId === club.id && !p.isYouth).length;
  if (seniorCount >= SENIOR_SQUAD_LIMIT) return { ok: false, error: "Professional squad is full" };

  settlePlayerPayroll(world, player);
  player.isYouth = false;
  resetPayrollPeriod(player, world.dayIndex);
  player.value = calculatePlayerValue(player.overall, player.age, remainingSeasons(player.contractDays));
  player.salary = promotedYouthSalary(player);
  player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
  player.tacPos = -1;
  player.starter = false;
  world.news.push({
    dayIndex: world.dayIndex,
    text: reason === "age" ? `${player.name} was automatically promoted from the youth academy at age ${player.age}` : `${player.name} was promoted from the youth academy to the senior squad`,
    kind: "academy",
    clubId: club.id,
  });
  return { ok: true };
}

export function dismissYouthPlayer(world: World, player: Player): { ok: boolean; error?: string } {
  const club = world.clubs.find((c) => c.id === player.clubId);
  if (!club || !player.isYouth) return { ok: false, error: "Player is not in the youth academy" };
  settlePlayerPayroll(world, player);
  world.players = world.players.filter((p) => p.id !== player.id);
  world.news.push({ dayIndex: world.dayIndex, text: `${player.name} was released from the youth academy`, kind: "academy", clubId: club.id });
  return { ok: true };
}

export function weeklyUpdate(rng: World["rng"], world: World) {
  for (const player of world.players) {
    if (player.injuryDays > 0) player.injuryDays--;
    if (player.energy < 100) player.energy += nextInt(rng, 6);
    potentialGrowth(rng, player);
  }
}

/** Pays wages accrued since the previous payroll boundary. */
export function settlePayroll(rng: World["rng"], world: World) {
  settlePayrollThrough(world);
}

export function updateCareerRecords(world: World) {
  let top: Player | null = null;
  for (const p of world.players) {
    if (!top || p.careerGoals > top.careerGoals) top = p;
  }
  upsertRecord(world, "all_time_top_scorer", top?.careerGoals ?? 0, top?.name ?? "—");
  let topSeason: Player | null = null;
  for (const p of world.players) {
    if (!topSeason || p.seasonGoals > topSeason.seasonGoals) topSeason = p;
  }
  upsertRecord(world, "most_goals_in_season", topSeason?.seasonGoals ?? 0, topSeason?.name ?? "—");
  // Division titles are tracked per club in `trophies`, keyed by division name
  // (invariant #19). The all-time leader holds the record.
  let topClub: Club | null = null;
  let topCount = 0;
  for (const club of world.clubs) {
    const titles = Object.values(club.trophies).reduce((sum, count) => sum + count, 0);
    if (titles > topCount) {
      topCount = titles;
      topClub = club;
    }
  }
  upsertRecord(world, "most_league_titles", topCount, topClub?.name ?? "—");
}

function upsertRecord(world: World, category: string, value: number, holderName: string) {
  const existing = world.records.find((r) => r.category === category);
  if (existing) {
    if (value > existing.value) {
      existing.value = value;
      existing.holderName = holderName;
    }
  } else {
    world.records.push({ category, value, holderName });
  }
}

export function computeSeasonAwards(world: World) {
  const season = world.mp.seasonYear;
  // Only the divisions of the season being archived are eligible; archived
  // competitions from earlier seasons must never produce duplicate awards.
  const comps = world.competitions.filter((c) => c.kind === "division" && c.seasonId === world.mp.seasonId && c.status !== "ARCHIVED");
  for (const comp of comps) {
    const clubIds = new Set(comp.config.clubs);
    const players = world.players.filter((p) => p.clubId !== null && clubIds.has(p.clubId));
    const scorers = [...players].sort((a, b) => b.seasonGoals - a.seasonGoals || b.seasonAssists - a.seasonAssists);
    const topScorer = scorers[0];
    if (topScorer && topScorer.seasonGoals > 0) {
      world.seasonAwards.push({
        season,
        category: "top_scorer",
        competitionId: comp.id,
        playerId: topScorer.id,
        clubId: topScorer.clubId,
        playerNameSnapshot: topScorer.name,
        detail: `${topScorer.seasonGoals} goals`,
      });
    }
    const assisters = [...players].sort((a, b) => b.seasonAssists - a.seasonAssists);
    const topAssister = assisters[0];
    if (topAssister && topAssister.seasonAssists > 0) {
      world.seasonAwards.push({
        season,
        category: "top_assists",
        competitionId: comp.id,
        playerId: topAssister.id,
        clubId: topAssister.clubId,
        playerNameSnapshot: topAssister.name,
        detail: `${topAssister.seasonAssists} assists`,
      });
    }
    let pot: Player | null = null;
    let potScore = -1;
    for (const p of players) {
      const score = p.overall + p.seasonGoals * 2 + p.seasonAssists;
      if (score > potScore) {
        potScore = score;
        pot = p;
      }
    }
    if (pot) {
      world.seasonAwards.push({
        season,
        category: "player_of_season",
        competitionId: comp.id,
        playerId: pot.id,
        clubId: pot.clubId,
        playerNameSnapshot: pot.name,
        detail: `Overall ${pot.overall}, ${pot.seasonGoals} goals, ${pot.seasonAssists} assists`,
      });
    }
    const pickBest = (position: number, count: number): Player[] => {
      const pool = players
        .filter((p) => p.position === position)
        .sort((a, b) => b.overall + b.seasonGoals * 2 - (a.overall + a.seasonGoals * 2));
      return pool.slice(0, count);
    };
    const xi = [...pickBest(0, 1), ...pickBest(1, 2), ...pickBest(2, 2), ...pickBest(3, 4), ...pickBest(4, 2)];
    if (xi.length > 0) {
      world.seasonAwards.push({
        season,
        category: "best_xi",
        competitionId: comp.id,
        playerId: null,
        clubId: null,
        playerNameSnapshot: null,
        detail: JSON.stringify(xi.map((p) => p.name)),
      });
    }
  }
}

/**
 * Weekly contract cycle. Human clubs only (invariant #28): ephemeral AI
 * squads never renew, expire or release players during their single season.
 * A human-club player whose contract clock reached zero leaves as a free
 * agent through the standard expiry transition.
 */
export function contractCycle(rng: World["rng"], world: World) {
  void rng;
  for (const player of [...world.players]) {
    if (player.clubId === null) continue;
    const club = world.clubs.find((c) => c.id === player.clubId);
    if (!club || club.competitionState !== "ACTIVE" || isEphemeralAI(club)) continue;
    if (player.isYouth || player.loanId !== null || playerHasActiveListing(world, player)) continue;
    if (player.contractDays <= 0) {
      processContractExpiry(world, player.id);
    }
  }
}

/**
 * Per-season salary the player requests for a renewal of `seasons` seasons,
 * based on his current salary, overall, and age. Shared by human and AI clubs.
 */
export function contractDemand(player: Player, seasons: number, currentSeasonFraction = 0): number {
  return calculateContractDemand(player.salary, player.overall, player.age, seasons, currentSeasonFraction);
}

/** Emit the ordinary player-facing warning for a contract nearing expiry. */
export function processContractWarning(world: World, playerId: number): void {
  const player = world.players.find((candidate) => candidate.id === playerId);
  const club = player?.clubId === null || player?.clubId === undefined ? undefined : world.clubs.find((candidate) => candidate.id === player.clubId);
  if (!player || !club || club.competitionState !== "ACTIVE" || player.contractDays <= 0 || player.contractDays > gameConfig.seasonDays * gameConfig.contractWarningSeasons) return;
  const text = `${player.name} (${club.name}) contract expiring soon`;
  if (!world.news.some((item) => item.kind === "contract" && item.clubId === club.id && item.text === text)) {
    world.news.push({ dayIndex: world.dayIndex, text, kind: "contract", clubId: club.id });
  }
}

/** Expire one contract through the same domain transition used by the cycle. */
export function processContractExpiry(world: World, playerId: number): void {
  const player = world.players.find((candidate) => candidate.id === playerId);
  if (!player || player.contractDays > 0 || player.clubId === null) return;
  const club = world.clubs.find((candidate) => candidate.id === player.clubId);
  if (!club || club.competitionState !== "ACTIVE") return;
  if (player.loanId !== null && player.loanId !== undefined) {
    const loan = world.loans.find((candidate) => candidate.id === player.loanId);
    if (loan) endLoan(world, loan);
  }
  const prepared = player.isYouth
    ? null
    : prepareFreeAgentListing(world, player, { allowOwnedPlayer: true });
  if (prepared && !prepared.ok) throw new Error(`Could not create free-agent listing after contract expiry: ${prepared.error}`);
  player.clubId = null;
  player.contractDays = Math.max(1, Math.round(DAYS_PER_YEAR / 2));
  player.tacPos = -1;
  player.starter = false;
  player.onSale = false;
  if (prepared && prepared.ok) world.freeAgentListings.push(prepared.listing);
  const text = `${player.name} left ${club.name} as a free agent after his contract expired`;
  if (!world.news.some((item) => item.kind === "contract" && item.clubId === club.id && item.text === text)) {
    world.news.push({ dayIndex: world.dayIndex, text, kind: "contract", clubId: club.id });
  }
}

export function endLoan(world: World, loan: { id: number; playerId: number; fromClubId: number; toClubId: number | null }) {
  const p = world.players.find((x) => x.id === loan.playerId);
  const full = world.loans.find((l) => l.id === loan.id);
  if (full) full.recalled = true;
  if (p) {
    if (p.clubId !== loan.fromClubId) {
      settlePlayerPayroll(world, p);
    }
    p.clubId = loan.fromClubId;
    p.loanId = null;
    p.tacPos = -1;
  }
  const from = world.clubs.find((c) => c.id === loan.fromClubId);
  const to = loan.toClubId !== null ? world.clubs.find((c) => c.id === loan.toClubId) : null;
  if (p && from) {
    world.news.push({
      dayIndex: world.dayIndex,
      text: to ? `${p.name} returned to ${from.name} after his loan at ${to.name} ended` : `${p.name} was removed from the loan list of ${from.name}`,
      kind: "loan",
      clubId: from.id,
    });
  }
}

/** Apply season-end aging, salary settlement, retirements, and contract expiry. */
export function processSeasonEndContracts(rng: World["rng"], world: World): void {
  // The configured season can end between payroll intervals. Settle the
  // remainder before resetting the day counter so every player earns one full
  // season salary.
  settlePayrollThrough(world, gameConfig.seasonDays);
  for (const player of world.players) {
    aging(rng, player, world.clubs.find((c) => c.id === player.clubId) ?? world.clubs[0]);
    // Contracts elapse only for clubs participating in the season (plan
    // §18/§45): provisional and dormant clubs keep their contract time frozen.
    const club = player.clubId !== null ? world.clubs.find((c) => c.id === player.clubId) : undefined;
    if (player.contractDays > 0 && (!club || club.competitionState === "ACTIVE")) {
      player.contractDays = Math.max(0, player.contractDays - DAYS_PER_YEAR);
    }
    // Market value is recalculated as age / overall / contract change; the
    // contract salary is fixed and is never recalculated at rollover.
    player.value = calculatePlayerValue(player.overall, player.age, remainingSeasons(player.contractDays));
    player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
  }
  const retirees: number[] = [];
  for (const player of world.players) {
    if (player.clubId !== null && !player.isYouth) {
      if (player.age >= 33 && chance(rng, 25)) {
        const club = world.clubs.find((c) => c.id === player.clubId);
        world.news.push({
          dayIndex: world.dayIndex,
          text: `${player.name} (${club?.name ?? ""}) announced this will be his last season`,
          kind: "retirement",
          clubId: club?.id,
        });
      }
      if (shouldRetire(rng, player)) {
        retirees.push(player.id);
      }
    }
  }
  world.players = world.players.filter((p) => !retirees.includes(p.id));
}

/** Run youth promotion, seasonal academy intake, and roster replacement. */
export function processSeasonalAcademyIntake(rng: World["rng"], world: World): void {
  for (const club of world.clubs) {
    // Ephemeral AI squads are static (invariant #28): no promotions, no
    // academy intake and no replacement generation for filler clubs.
    if (isEphemeralAI(club)) continue;
    let squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    let juniors = world.players.filter((p) => p.clubId === club.id && p.isYouth);
    const juniorsToPromote = juniors.filter((p) => p.age >= 21);
    for (const j of juniorsToPromote) {
      const result = promoteYouthPlayer(world, j, "age");
      if (!result.ok) {
        world.news.push({ dayIndex: world.dayIndex, text: `${j.name} reached 21 but could not be promoted because the professional squad is full`, kind: "academy", clubId: club.id });
      }
    }
    // Seasonal academy intake (player-generation §42-§45): after aging and
    // promotion, generate the resolved deterministic quota subject only to
    // academy roster slots. Unused intake slots are lost — never banked, and
    // releasing youth cannot increase the quota. Idempotent per club/season.
    const seasonId = world.mp.seasonId;
    if (seasonId !== 0 && !academyIntakeDone(world, club.id, seasonId)) {
      generateSeasonalAcademyIntake({
        world,
        club,
        currentDivision: divisionForClub(world, club.id),
        highestDivisionReached: club.highestDivision,
        totalDivisions: Math.max(1, lowestActiveTier(world, seasonId)),
        seasonId,
      });
      markAcademyIntakeDone(world, club.id, seasonId);
    }
    squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    if (squad.length < 20) {
      const division = divisionForClub(world, club.id);
      const totalDivisions = Math.max(1, lowestActiveTier(world, seasonId));
      for (let i = squad.length; i < 20; i++) {
        const slot = i;
        const p = generateSeniorPlayer({
          id: world.nextId++,
          clubId: club.id,
          country: club.country,
          position: 3,
          isYouth: false,
          currentDivision: division,
          highestDivisionReached: club.highestDivision,
          totalDivisions,
          seasonId,
          generationType: "replacement",
          seed: world.seed,
          slot,
        });
        resetPayrollPeriod(p, world.dayIndex);
        world.players.push(p);
      }
    }
  }
}

/** Commit the new season's player-facing reset after all workflow steps pass. */
export function commitSeasonRollover(world: World): void {
  world.year += 1;
  world.dayIndex = 0;
  world.dayOfWeek = 0;
  for (const player of world.players) resetPayrollPeriod(player, 0);
  // Season structure (fixtures, standings reset, promotions) is owned by the
  // multiplayer engine during season rollover, not here.
  world.matches = [];
  // Multiplayer auctions use absolute deadlines and may legitimately cross a
  // month boundary. Keep all listings alive; the worker settles timestamped
  // listings, while legacy rows continue through the day-based compatibility
  // path.
  const academyNews = world.news
    .filter((item) => item.kind === "academy")
    .map((item) => ({ ...item, dayIndex: 0 }));
  world.news = academyNews;
  for (const player of world.players) {
    player.seasonGoals = 0;
    player.seasonAssists = 0;
    player.yellows = 0;
    player.reds = 0;
    player.energy = 100;
    player.onSale = world.transferAuctions.some((listing) => listing.status === "ACTIVE" && listing.playerId === player.id)
      || world.freeAgentListings.some((listing) => listing.status === "ACTIVE" && listing.playerId === player.id);
  }
}
