import type { Club, Player, World } from "./types";
import { chance, nextInt, pick } from "./rng";
import {
  aging,
  potentialGrowth,
  shouldRetire,
} from "./player";
import { DAYS_PER_YEAR } from "./constants";
import { sortedStandings } from "./league";
import { squadNeeds } from "./transfers";
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
import { evaluateAIDecision, getImmediateAvailableCash, remainingSalaryCommitmentForPlayer, salaryCommitmentForPeriod } from "./finance";

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

export const SENIOR_SQUAD_LIMIT = 35;

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

export function clubLastMatch(world: World, clubId: number) {
  for (let i = world.matches.length - 1; i >= 0; i--) {
    const m = world.matches[i];
    if (m.homeClubId === clubId || m.awayClubId === clubId) return m;
  }
  return null;
}

function lastMatchXI(world: World, clubId: number): Set<number> {
  const last = clubLastMatch(world, clubId);
  if (!last) return new Set();
  const ids = new Set<number>();
  const subbedOff = new Set<number>();
  for (const ev of last.events) {
    if (ev.clubId !== clubId) continue;
    if (ev.type === 6) {
      if (ev.playerId !== null) subbedOff.add(ev.playerId);
      if (ev.player2Id !== null) ids.add(ev.player2Id);
    } else if (ev.playerId !== null) {
      ids.add(ev.playerId);
    }
  }
  for (const id of subbedOff) ids.delete(id);
  return ids;
}

export function weeklyUpdate(rng: World["rng"], world: World) {
  for (const club of world.clubs) {
    const last = clubLastMatch(world, club.id);
    const won =
      last !== null &&
      ((last.homeClubId === club.id && last.homeScore > last.awayScore) ||
        (last.awayClubId === club.id && last.awayScore > last.homeScore));
    const lost =
      last !== null &&
      ((last.homeClubId === club.id && last.homeScore < last.awayScore) ||
        (last.awayClubId === club.id && last.awayScore < last.homeScore));
    for (const player of world.players) {
      if (player.clubId !== club.id) continue;
      if (player.injuryDays > 0) player.injuryDays--;
      if (player.energy < 100) player.energy += nextInt(rng, 6);
      potentialGrowth(rng, player);
      if (won) player.morale = Math.min(100, player.morale + 2);
      if (lost) player.morale = Math.max(0, player.morale - 2);
      if (player.starter) player.morale = Math.min(100, player.morale + 1);
      else if (player.injuryDays === 0 && !player.isYouth) player.morale = Math.max(0, player.morale - 3);
    }
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
  let topClub: Club | null = null;
  let topCount = 0;
  for (const club of world.clubs) {
    let titles = 0;
    for (const comp of world.competitions) {
      if (comp.kind === "league") titles += club.trophies[comp.name] ?? 0;
    }
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
  const season = world.year;
  for (const comp of world.competitions) {
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

export function contractCycle(rng: World["rng"], world: World) {
  for (const player of [...world.players]) {
    if (player.clubId === null) continue;
    const club = world.clubs.find((c) => c.id === player.clubId);
    if (!club || club.competitionState !== "ACTIVE") continue;
    if (player.contractDays <= 0) {
      processContractExpiry(world, player.id);
      continue;
    }
    if (club.isHuman) continue;
    const warningThreshold = gameConfig.seasonDays * gameConfig.contractWarningSeasons;
    if (player.contractDays <= warningThreshold) {
      const maxSeasons = gameConfig.maxContractSeasons;
      const offerSeasons = 1 + nextInt(rng, maxSeasons);
      const demand = calculateContractDemand(player.salary, player.overall, player.age, offerSeasons);
      // AI renewal uses the same demand model as the human player; the club
      // only decides whether it can afford it and for how long. The AI's hard
      // financial safety rule (financial-control §13) is enforced with the
      // shared commitment calculator: the new salary must not push the
      // financial cushion below 0.
      const currentSalaryCommitment = remainingSalaryCommitmentForPlayer(player);
      const accruedSalaryToSettle = remainingSalaryCommitmentForPlayer(player, world.dayIndex);
      const renewedSalaryCommitment = salaryCommitmentForPeriod(demand, world.dayIndex, gameConfig.seasonDays);
      const affordable = evaluateAIDecision(world, club, {
        immediateCost: accruedSalaryToSettle,
        newBidCommitments: 0,
        additionalSalary: 0,
        additionalSalaryCommitment: renewedSalaryCommitment,
        replacedSalaryCommitment: currentSalaryCommitment,
      });
      if (affordable && demand > player.salary) {
        settlePlayerPayroll(world, player);
        resetPayrollPeriod(player, world.dayIndex);
        player.salary = demand;
        player.contractDays = DAYS_PER_YEAR * offerSeasons;
        player.morale = Math.min(100, player.morale + 5);
      } else if (chance(rng, 30)) {
        world.news.push({
          dayIndex: world.dayIndex,
          text: `${player.name} (${club.name}) rejected a renewal offer and may leave at the end of his contract`,
          kind: "contract",
          clubId: club.id,
        });
        player.morale = Math.max(0, player.morale - 5);
      }
    }
  }
}

/**
 * Per-season salary the player requests for a renewal of `seasons` seasons,
 * based on his current salary, overall, and age. Shared by human and AI clubs.
 */
export function contractDemand(player: Player, seasons: number): number {
  return calculateContractDemand(player.salary, player.overall, player.age, seasons);
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
  player.clubId = null;
  player.contractDays = Math.max(1, Math.round(DAYS_PER_YEAR / 2));
  player.tacPos = -1;
  player.starter = false;
  player.onSale = false;
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

export function loanCycle(rng: World["rng"], world: World) {
  for (const club of world.clubs) {
    if (club.isHuman || club.competitionState !== "ACTIVE" || !chance(rng, 15)) continue;
    const roster = world.players.filter(
      (p) =>
        p.clubId === club.id && !p.isYouth && !p.onSale && p.loanId === null && p.injuryDays === 0 && p.overall < 70
    );
    if (roster.length === 0) continue;
    const inXI = lastMatchXI(world, club.id);
    const candidates = roster.filter((p) => !inXI.has(p.id));
    if (candidates.length === 0) continue;
    const endDay = seasonEndDay(world.dayIndex, DAYS_PER_YEAR * gameConfig.loanDurationSeasons);
    const contractEligible = candidates.filter((p) => loanFitsContract(world.dayIndex, endDay, p.contractDays));
    if (contractEligible.length === 0) continue;
    const p = pick(rng, contractEligible);
    world.loans.push({
      id: world.nextId++,
      playerId: p.id,
      fromClubId: club.id,
      toClubId: null,
      startDay: world.dayIndex,
      endDay,
      recalled: false,
      listedAt: Date.now(),
      claimableAt: Date.now(),
    });
    world.mp.loanEndAbsoluteGameDays ??= {};
    world.mp.loanEndAbsoluteGameDays[String(world.loans.at(-1)!.id)] = (world.mp.absoluteGameDay ?? world.dayIndex) + (endDay - world.dayIndex);
    world.news.push({
      dayIndex: world.dayIndex,
      text: `${club.name} listed ${p.name} on the loan list`,
      kind: "loan",
      clubId: club.id,
    });
  }
  for (const loan of [...world.loans]) {
    if (loan.recalled) continue;
    const absoluteEnd = world.mp.loanEndAbsoluteGameDays?.[String(loan.id)] ?? loan.endDay;
    if (absoluteEnd <= (world.mp.absoluteGameDay ?? world.dayIndex)) {
      endLoan(world, loan);
    } else if (loan.toClubId !== null && chance(rng, 5)) {
      endLoan(world, loan);
    }
  }
  for (const club of world.clubs) {
    if (club.isHuman || !chance(rng, 12)) continue;
    const needs = squadNeeds(club, world.players);
    const candidates = world.loans.filter((l) => {
      const absoluteEnd = world.mp.loanEndAbsoluteGameDays?.[String(l.id)] ?? l.endDay;
      if (l.toClubId !== null || l.recalled || absoluteEnd <= (world.mp.absoluteGameDay ?? world.dayIndex)) return false;
      const p = world.players.find((x) => x.id === l.playerId);
      if (!p || p.clubId === club.id || needs[p.position] <= 0) return false;
      return evaluateAIDecision(world, club, {
        immediateCost: 0,
        newBidCommitments: 0,
        additionalSalary: 0,
        additionalSalaryCommitment: salaryCommitmentForPeriod(p.salary, world.dayIndex, Math.min(gameConfig.seasonDays, l.endDay)),
      });
    });
    if (candidates.length === 0) continue;
    const loan = pick(rng, candidates);
    const p = world.players.find((x) => x.id === loan.playerId)!;
    settlePlayerPayroll(world, p);
    loan.toClubId = club.id;
    p.loanId = loan.id;
    p.clubId = club.id;
    world.news.push({
      dayIndex: world.dayIndex,
      text: `${club.name} took ${p.name} on loan`,
      kind: "loan",
      clubId: club.id,
    });
  }
}

export function stadiumCycle(world: World) {
  const currentAbsolute = world.mp.absoluteGameDay ?? world.dayIndex;
  const due = world.stadiumUpgrades.filter((u) => {
    const absoluteDue = world.mp.stadiumCompletionAbsoluteGameDays?.[String(u.clubId)];
    return !u.completed && (absoluteDue !== undefined ? absoluteDue <= currentAbsolute : u.completesDay <= world.dayIndex);
  });
  for (const u of due) {
    const club = world.clubs.find((c) => c.id === u.clubId);
    if (club) {
      club.stadiumCapacity = u.newCapacity;
      world.news.push({
        dayIndex: world.dayIndex,
        text: `${club.name} inaugurated its expanded stadium: ${u.newCapacity} seats`,
        kind: "stadium",
        clubId: club.id,
      });
    }
    u.completed = true;
  }
}

export function startStadiumUpgrade(world: World, club: Club): { error?: string; upgrade?: World["stadiumUpgrades"][number] } {
  if (world.stadiumUpgrades.some((u) => u.clubId === club.id && u.startedDay >= world.dayIndex - (DAYS_PER_YEAR - 1))) {
    return { error: "Only one stadium upgrade is allowed per season" };
  }
  if (world.stadiumUpgrades.some((u) => u.clubId === club.id && !u.completed)) {
    return { error: "A stadium upgrade is already under construction" };
  }
  const newCapacity = club.stadiumCapacity + 5000;
  const cost = Math.round((newCapacity / 5000) ** 2 * 1_000_000);
  // §9/§64: a new immediate expense (stadium upgrade) requires actual
  // unreserved cash. Binding bid reservations are not available for spending,
  // even though the cushion may be negative for humans.
  if (getImmediateAvailableCash(world, club) < cost) {
    return { error: "Not enough unreserved cash for this upgrade" };
  }
  club.cash -= cost;
  club.ledger.expense.push({ code: 12, amount: cost, day: world.dayIndex, label: "Stadium expansion" });
  const upgrade = { clubId: club.id, startedDay: world.dayIndex, completesDay: seasonEndDay(world.dayIndex, gameConfig.stadiumUpgradeDays), newCapacity, cost, completed: false };
  world.stadiumUpgrades.push(upgrade);
  world.mp.stadiumCompletionAbsoluteGameDays ??= {};
  world.mp.stadiumCompletionAbsoluteGameDays[String(club.id)] = (world.mp.absoluteGameDay ?? world.dayIndex) + gameConfig.stadiumUpgradeDays;
  world.news.push({ dayIndex: world.dayIndex, text: `${club.name} began a stadium expansion to ${newCapacity} seats`, kind: "stadium", clubId: club.id });
  return { upgrade };
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
    let squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    let juniors = world.players.filter((p) => p.clubId === club.id && p.isYouth);
    const juniorsToPromote = juniors.filter((p) => p.age >= 21);
    for (const j of juniorsToPromote) {
      const result = promoteYouthPlayer(world, j, "age");
      if (!result.ok) {
        world.news.push({ dayIndex: world.dayIndex, text: `${j.name} reached 21 but could not be promoted because the professional squad is full`, kind: "academy", clubId: club.id });
      }
    }
    // Fixed seasonal academy intake (player-generation §42-§45): after aging
    // and promotion, generate the fixed intake subject only to academy roster
    // slots. Unused intake slots are lost — never banked, and releasing youth
    // cannot increase the quota. Idempotent per club/season.
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
    player.onSale = false;
    player.morale = Math.max(30, Math.min(100, player.morale));
  }
}

/** Preserve the legacy all-in-one API for callers outside the scheduler. */
export function rolloverSeason(rng: World["rng"], world: World): void {
  processSeasonEndContracts(rng, world);
  processSeasonalAcademyIntake(rng, world);
  commitSeasonRollover(world);
}
