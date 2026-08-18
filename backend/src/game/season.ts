import type { Club, Player, World } from "./types";
import { chance, nextInt, pick } from "./rng";
import {
  aging,
  generatePlayer,
  potentialGrowth,
  shouldRetire,
} from "./player";
import { LEAGUE_PRIZES, SPONSORSHIP, TV_POSITION_BONUS, DAYS_PER_YEAR } from "./constants";
import { getPosition, sortedStandings } from "./league";
import { squadNeeds } from "./transfers";
import { generateName } from "./names";
import { gameConfig, LEAGUE_LAST_MATCH_DAY } from "../config";
import { resetPayrollPeriod, settlePayrollThrough, settlePlayerPayroll } from "./payroll";
import {
  calculateBaseSalary,
  calculateContractDemand,
  calculatePlayerValue,
  calculateReleaseClause,
  remainingSeasons,
} from "./economy";

/** Latest day-of-season a deadline can resolve: the season rolls over on the
 * day after the final league round (LEAGUE_LAST_MATCH_DAY + 1), so any deadline
 * beyond that would be unreachable after dayIndex resets. */
export function seasonEndDay(dayIndex: number, daysFromNow: number): number {
  return Math.min(LEAGUE_LAST_MATCH_DAY + 1, dayIndex + daysFromNow);
}

export function loanFitsContract(startDay: number, endDay: number, contractDays: number): boolean {
  return endDay > startDay && endDay - startDay <= contractDays;
}

export const SENIOR_SQUAD_LIMIT = 35;
const ACADEMY_TARGET = 8;

function humanControlled(club: Club): boolean {
  return club.isHuman || club.ownerUserId !== null;
}

export function fairSalaryForPlayer(player: Player): number {
  return calculateBaseSalary(player.overall, player.age);
}

export function promotedYouthSalary(player: Player): number {
  return Math.max(gameConfig.salaryFloor, Math.round(fairSalaryForPlayer(player) * 0.8));
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function weeklyUpdate(rng: World["rng"], world: World) {
  for (const club of world.clubs) {
    const participates = club.competitionState === "ACTIVE";
    const last = participates ? clubLastMatch(world, club.id) : null;
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
      if (participates && won) player.morale = Math.min(100, player.morale + 2);
      if (participates && lost) player.morale = Math.max(0, player.morale - 2);
      if (participates && player.starter) player.morale = Math.min(100, player.morale + 1);
      else if (participates && player.injuryDays === 0 && !player.isYouth) player.morale = Math.max(0, player.morale - 3);
      if (participates && player.morale < 25 && !player.onSale && !player.isYouth) {
        player.onSale = true;
        player.salePrice = Math.round(player.value * 0.8);
        world.news.push({
          dayIndex: world.dayIndex,
          text: `${player.name} is unhappy at ${club.name} and requested a transfer`,
          kind: "morale",
          clubId: club.id,
        });
      }
    }
    const squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    if (squad.length > 0) {
      const avgMorale = squad.reduce((s, p) => s + p.morale, 0) / squad.length;
      if (avgMorale < 30) {
        club.fanConfidence = Math.max(0, club.fanConfidence - 2);
        if (chance(rng, 20)) {
          world.news.push({
            dayIndex: world.dayIndex,
            text: `A rift is growing in the ${club.name} dressing room`,
            kind: "morale",
            clubId: club.id,
          });
        }
      }
    }
    if (!humanControlled(club)) maybeFireManager(rng, world, club);
  }
  const humans = world.clubs.filter((club) => humanControlled(club));
  for (const human of humans) {
    const league = world.competitions.find((c) => c.kind === "league" && c.standings[human.id])
      ?? world.competitions.find((c) => c.kind === "division" && c.seasonId === world.mp.seasonId && c.standings[human.id]);
    if (league && league.standings[human.id]) {
      const pos = getPosition(league, human.id);
      const expectation = 4;
      if (pos <= expectation) human.boardConfidence = Math.min(100, human.boardConfidence + 1);
      else human.boardConfidence = Math.max(0, human.boardConfidence - 1);
    }
    if (human.boardConfidence < 35 && chance(rng, 30)) {
      world.news.push({
        dayIndex: world.dayIndex,
        text: `The board of ${human.name} warns the manager to watch the transfer budget`,
        kind: "finance",
        clubId: human.id,
      });
    }
  }
}

function maybeFireManager(rng: World["rng"], world: World, club: Club) {
  const results = world.matches.filter((m) => m.homeClubId === club.id || m.awayClubId === club.id);
  const last10 = results.slice(-10);
  if (last10.length < 6) return;
  const wins = last10.filter(
    (m) =>
      (m.homeClubId === club.id && m.homeScore > m.awayScore) ||
      (m.awayClubId === club.id && m.awayScore > m.homeScore)
  ).length;
  if (wins <= 2 && club.boardConfidence < 30) {
    const reasons = [
      "financial ruin",
      "fan pressure over poor results",
      "results that pleased neither the fans nor the board",
    ];
    const reason = pick(rng, reasons);
    const history = world.managerHistory.filter((h) => h.clubId === club.id);
    const lastAppointment = history.length > 0 ? Math.max(...history.map((h) => h.appointedDay)) : 0;
    const gamesInCharge = results.filter((m) => {
      const fixture = world.fixtures.find((f) => f.id === m.fixtureId);
      return (fixture?.dayIndex ?? world.dayIndex) >= lastAppointment;
    }).length;
    world.managerHistory.push({
      clubId: club.id,
      name: club.coachName,
      appointedDay: lastAppointment > 0 ? lastAppointment : 0,
      departedDay: world.dayIndex,
      gamesInCharge,
      reason,
    });
    world.news.push({
      dayIndex: world.dayIndex,
      text: `${club.name} fired manager ${club.coachName} over ${reason}`,
      kind: "manager",
      clubId: club.id,
    });
    club.coachName = generateName(rng, club.country);
    club.boardConfidence = 60;
    club.fanConfidence = Math.max(0, club.fanConfidence - 3);
  }
}

/** Pays wages accrued since the previous payroll boundary. */
export function settlePayroll(rng: World["rng"], world: World) {
  const salaries = settlePayrollThrough(world);
  for (const club of world.clubs) {
    if (!salaries.has(club.id)) continue;
    if (club.cash < 0) {
      club.boardConfidence = Math.max(0, club.boardConfidence - 10);
      if (club.boardConfidence < 25) {
        const penalty = Math.round(Math.abs(club.cash) * 0.02);
        club.cash -= penalty;
        club.ledger.expense.push({ code: 9, amount: penalty, day: world.dayIndex, label: "Overdraft penalty" });
        world.news.push({
          dayIndex: world.dayIndex,
          text: `The bank charged ${club.name} an overdraft penalty`,
          kind: "finance",
          clubId: club.id,
        });
      }
    }
  }
}

export function yearlySponsorship(world: World) {
  for (const club of world.clubs) {
    if (club.competitionState !== "ACTIVE") continue;
    const tier = Math.min(5, Math.max(1, Math.round(club.level / 5)));
    const amount = SPONSORSHIP[tier - 1];
    world.tvDeals.push({ clubId: club.id, season: world.year, baseAmount: amount, positionBonus: 0 });
    club.cash += amount;
    club.ledger.income.push({ code: 6, amount, day: world.dayIndex, label: "TV deal (base)" });
  }
}

export function awardTvPositionBonuses(world: World) {
  for (const comp of world.competitions) {
    if (comp.kind !== "league" && comp.kind !== "division") continue;
    const sorted = sortedStandings(comp);
    for (let i = 0; i < sorted.length; i++) {
      const bonus = TV_POSITION_BONUS[i];
      if (!bonus || bonus <= 0) continue;
      const club = world.clubs.find((c) => c.id === sorted[i].clubId);
      if (!club) continue;
      const deal = world.tvDeals.find((d) => d.clubId === club.id && d.season === world.year);
      if (deal) deal.positionBonus = bonus;
      club.cash += bonus;
      club.ledger.income.push({ code: 11, amount: bonus, day: world.dayIndex, label: `TV position bonus (${comp.name})` });
    }
  }
}

export function awardLeaguePrizes(world: World) {
  for (const comp of world.competitions) {
    if (comp.kind !== "league" && comp.kind !== "division") continue;
    const sorted = sortedStandings(comp);
    for (let i = 0; i < Math.min(LEAGUE_PRIZES.length, sorted.length); i++) {
      const prize = LEAGUE_PRIZES[i];
      if (prize <= 0) continue;
      const club = world.clubs.find((c) => c.id === sorted[i].clubId);
      if (club) {
        club.cash += prize;
        club.ledger.income.push({ code: 5, amount: prize, day: world.dayIndex, label: `League prize (${comp.name})` });
      }
    }
  }
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
  const freeAgentDays = Math.max(1, Math.round(DAYS_PER_YEAR / 2));
  for (const player of [...world.players]) {
    if (player.clubId === null) continue;
    const club = world.clubs.find((c) => c.id === player.clubId);
    if (!club || club.competitionState !== "ACTIVE") continue;
    if (player.contractDays <= 0) {
      if (player.loanId !== null && player.loanId !== undefined) {
        const loan = world.loans.find((l) => l.id === player.loanId);
        if (loan) endLoan(world, loan);
      }
      player.clubId = null;
      player.contractDays = freeAgentDays;
      player.tacPos = -1;
      player.starter = false;
      player.onSale = false;
      player.salePrice = null;
      world.news.push({
        dayIndex: world.dayIndex,
        text: `${player.name} left ${club?.name ?? "his club"} as a free agent after his contract expired`,
        kind: "contract",
        clubId: club?.id,
      });
      continue;
    }
    if (humanControlled(club)) continue;
    const warningThreshold = gameConfig.seasonDays * gameConfig.contractWarningSeasons;
    if (player.contractDays <= warningThreshold) {
      const maxSeasons = gameConfig.maxContractSeasons;
      const offerSeasons = 1 + nextInt(rng, maxSeasons);
      const demand = calculateContractDemand(player.salary, player.overall, player.age, offerSeasons);
      // AI renewal uses the same demand model as the human player; the club
      // only decides whether it can afford it and for how long.
      if (club.cash > demand && demand > player.salary) {
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
    if (humanControlled(club) || !chance(rng, 15)) continue;
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
    });
    world.news.push({
      dayIndex: world.dayIndex,
      text: `${club.name} listed ${p.name} on the loan list`,
      kind: "loan",
      clubId: club.id,
    });
  }
  for (const loan of [...world.loans]) {
    if (loan.recalled) continue;
    if (loan.endDay <= world.dayIndex) {
      endLoan(world, loan);
    } else if (loan.toClubId !== null && chance(rng, 5)) {
      endLoan(world, loan);
    }
  }
  for (const club of world.clubs) {
    if (humanControlled(club) || !chance(rng, 12)) continue;
    const needs = squadNeeds(club, world.players);
    const candidates = world.loans.filter((l) => {
      if (l.toClubId !== null || l.recalled) return false;
      const p = world.players.find((x) => x.id === l.playerId);
      return p && p.clubId !== club.id && needs[p.position] > 0;
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
  const due = world.stadiumUpgrades.filter((u) => u.completesDay <= world.dayIndex && !u.completed);
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
  if (club.cash < cost) return { error: "Not enough cash for this upgrade" };
  club.cash -= cost;
  club.ledger.expense.push({ code: 12, amount: cost, day: world.dayIndex, label: "Stadium expansion" });
  const upgrade = { clubId: club.id, startedDay: world.dayIndex, completesDay: seasonEndDay(world.dayIndex, gameConfig.stadiumUpgradeDays), newCapacity, cost, completed: false };
  world.stadiumUpgrades.push(upgrade);
  world.news.push({ dayIndex: world.dayIndex, text: `${club.name} began a stadium expansion to ${newCapacity} seats`, kind: "stadium", clubId: club.id });
  return { upgrade };
}

export function rolloverSeason(rng: World["rng"], world: World): void {
  // The configured season can end between payroll intervals. Settle the
  // remainder before resetting the day counter so every player earns one full
  // season salary.
  const salaries = settlePayrollThrough(world, gameConfig.seasonDays);
  for (const club of world.clubs) {
    if (!salaries.has(club.id)) continue;
    if (club.cash < 0) {
      club.boardConfidence = Math.max(0, club.boardConfidence - 10);
      if (club.boardConfidence < 25) {
        const penalty = Math.round(Math.abs(club.cash) * 0.02);
        club.cash -= penalty;
        club.ledger.expense.push({ code: 9, amount: penalty, day: world.dayIndex, label: "Overdraft penalty" });
        world.news.push({ dayIndex: world.dayIndex, text: `The bank charged ${club.name} an overdraft penalty`, kind: "finance", clubId: club.id });
      }
    }
  }
  const clubs = world.clubs;
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
    juniors = world.players.filter((p) => p.clubId === club.id && p.isYouth);
    squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    const need = Math.max(0, ACADEMY_TARGET - juniors.length);
    for (let i = 0; i < need; i++) {
      const youth = generatePlayer(rng, club, { isYouth: true, id: world.nextId++, seed: world.seed });
      resetPayrollPeriod(youth, world.dayIndex);
      world.players.push(youth);
      world.news.push({ dayIndex: world.dayIndex, text: `${youth.name} joined the youth academy`, kind: "academy", clubId: club.id });
    }
    if (squad.length < 20) {
      for (let i = squad.length; i < 20; i++) {
        const p = generatePlayer(rng, club, { id: world.nextId++, seed: world.seed });
        resetPayrollPeriod(p, world.dayIndex);
        world.players.push(p);
      }
    }
    club.boardConfidence = 50;
    club.fanConfidence = 50;
  }
  // Multiplayer seasons are calendar months, not an abstract annual counter.
  // `mp.seasonYear` has already been advanced by the rollover coordinator.
  world.year = world.mp.seasonYear;
  world.dayIndex = 0;
  world.dayOfWeek = 0;
  for (const player of world.players) resetPayrollPeriod(player, 0);
  // Season structure (fixtures, standings reset, promotions) is owned by the
  // multiplayer engine during season rollover, not here. Completed matches
  // remain available through archived fixture history.
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
    player.salePrice = null;
    player.morale = Math.max(30, Math.min(100, player.morale));
  }
}
