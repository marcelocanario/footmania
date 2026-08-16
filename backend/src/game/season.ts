import type { Club, World } from "./types";
import { nextInt, chance } from "./rng";
import {
  aging,
  calcSalary,
  calcValue,
  generatePlayer,
  shouldRetire,
  weeklyDecline,
  weeklyGrowth,
} from "./player";
import { LEAGUE_PRIZES, SPONSORSHIP, STATE_PRIZES, CUP_PRIZES } from "./constants";
import { promotionRelegation, sortedStandings } from "./league";
import { findCupWinner } from "./cup";
import { generateFreeAgents } from "./transfers";
import { generateName } from "./names";
import { buildSeasonStructure } from "./worldgen";

export function weeklyUpdate(rng: World["rng"], world: World) {
  for (const club of world.clubs) {
    for (const player of world.players) {
      if (player.clubId !== club.id) continue;
      if (player.injuryDays > 0) player.injuryDays--;
      if (player.energy < 100) player.energy += nextInt(rng, 6);
      if (player.age < 32) weeklyGrowth(rng, player, club);
      else weeklyDecline(rng, player, club);
      potentialGrowthIfYoung(player);
    }
  }
}

function potentialGrowthIfYoung(player: { age: number; potentialAcc: number; potential: number }) {
  if (player.age > 20) return;
}

export function monthlyFinances(rng: World["rng"], world: World) {
  for (const club of world.clubs) {
    let salaries = 0;
    for (const player of world.players) {
      if (player.clubId === club.id) salaries += player.salary;
    }
    club.cash -= salaries;
    club.ledger.expense.push({ code: 4, amount: salaries, day: world.dayIndex, label: "Player salaries" });
    if (club.loanBalance > 0) {
      const interest = Math.round(club.loanBalance * 0.03);
      club.cash -= interest;
      club.ledger.expense.push({ code: 8, amount: interest, day: world.dayIndex, label: "Loan interest" });
    }
    if (club.cash < 0) {
      club.boardConfidence = Math.max(0, club.boardConfidence - 10);
    }
  }
}

export function payWeeklySalaries(rng: World["rng"], world: World) {
  for (const club of world.clubs) {
    let total = 0;
    for (const player of world.players) {
      if (player.clubId === club.id) total += Math.round(player.salary / 52);
    }
    club.cash -= total;
    club.ledger.expense.push({ code: 4, amount: total, day: world.dayIndex, label: "Weekly salaries" });
  }
}

export function yearlySponsorship(world: World) {
  for (const club of world.clubs) {
    const div = Math.min(4, club.division);
    const amount = SPONSORSHIP[div >= 3 ? 1 : div][0];
    club.cash += amount;
    club.ledger.income.push({ code: 6, amount, day: world.dayIndex, label: "Sponsorship" });
  }
}

export function awardLeaguePrizes(world: World) {
  for (const comp of world.competitions) {
    if (comp.kind !== "league") continue;
    const sorted = sortedStandings(comp);
    const prizes = LEAGUE_PRIZES[Math.min(4, comp.division)] ?? [];
    for (let i = 0; i < Math.min(prizes.length, sorted.length); i++) {
      const prize = prizes[i];
      if (prize <= 0) continue;
      const club = world.clubs.find((c) => c.id === sorted[i].clubId);
      if (club) {
        club.cash += prize;
        club.ledger.income.push({ code: 5, amount: prize, day: world.dayIndex, label: `League prize (${comp.name})` });
      }
    }
  }
}

export function awardStatePrizes(world: World) {
  for (const comp of world.competitions) {
    if (comp.kind !== "state" || comp.stage !== "finished") continue;
    if (comp.winners.length > 0) {
      const club = world.clubs.find((c) => c.id === comp.winners[0]);
      if (club) {
        const prize = STATE_PRIZES[0];
        club.cash += prize;
        club.ledger.income.push({ code: 5, amount: prize, day: world.dayIndex, label: `State title (${comp.name})` });
        club.trophies[comp.name] = (club.trophies[comp.name] ?? 0) + 1;
      }
    }
  }
}

export function awardCupPrizes(world: World) {
  for (const comp of world.competitions) {
    if (comp.kind !== "cup" || comp.stage !== "finished") continue;
    const winner = findCupWinner(comp);
    if (winner !== null) {
      const club = world.clubs.find((c) => c.id === winner);
      if (club) {
        const prize = CUP_PRIZES[1][5];
        club.cash += prize;
        club.ledger.income.push({ code: 5, amount: prize, day: world.dayIndex, label: `Cup title (${comp.name})` });
        club.trophies[comp.name] = (club.trophies[comp.name] ?? 0) + 1;
      }
    }
  }
}

export function rolloverSeason(rng: World["rng"], world: World): { promoted: number[]; relegated: number[]; cupChampionId: number | null; stateChampionId: number | null } {
  const clubs = world.clubs;
  const promotedAll: number[] = [];
  const relegatedAll: number[] = [];
  for (const comp of world.competitions) {
    if (comp.kind === "league") {
      const { promoted, relegated } = promotionRelegation(comp, clubs);
      if (comp.division === 1) {
        for (const cid of relegated) relegatedAll.push(cid);
      } else {
        for (const cid of promoted) promotedAll.push(cid);
      }
    }
  }
  for (const cid of promotedAll) {
    const club = clubs.find((c) => c.id === cid);
    if (club && club.division > 1) {
      club.division--;
      club.reputation = Math.min(5, club.reputation + 1);
    }
  }
  for (const cid of relegatedAll) {
    const club = clubs.find((c) => c.id === cid);
    if (club && club.division < 2) {
      club.division++;
      club.reputation = Math.max(1, club.reputation - 1);
    }
  }
  for (const player of world.players) {
    aging(rng, player, world.clubs.find((c) => c.id === player.clubId) ?? world.clubs[0]);
    const club = world.clubs.find((c) => c.id === player.clubId);
    if (club) {
      player.value = calcValue(club, player.overall, player.age, player.tier, player.isStar, player.worldClass, player.isYouth);
      player.salary = calcSalary(club, player.overall, player.age, player.isStar, player.worldClass, player.isYouth);
    }
    if (player.contractDays > 0) player.contractDays = Math.max(0, player.contractDays - 365);
  }
  const retirees: number[] = [];
  for (const player of world.players) {
    if (player.clubId !== null && shouldRetire(rng, player)) {
      retirees.push(player.id);
    }
  }
  world.players = world.players.filter((p) => !retirees.includes(p.id));
  for (const club of world.clubs) {
    const squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    const juniors = world.players.filter((p) => p.clubId === club.id && p.isYouth);
    const juniorsToPromote = juniors.filter((p) => p.age >= 19);
    for (const j of juniorsToPromote) {
      j.isYouth = false;
      j.salary = calcSalary(club, j.overall, j.age, j.isStar, j.worldClass, false);
    }
    const need = Math.max(0, 8 - juniors.length);
    for (let i = 0; i < need; i++) {
      const youth = generatePlayer(rng, club, { isYouth: true, id: world.nextId++ });
      world.players.push(youth);
    }
    if (squad.length < 20) {
      for (let i = squad.length; i < 20; i++) {
        const p = generatePlayer(rng, club, { id: world.nextId++ });
        world.players.push(p);
      }
    }
    club.boardConfidence = 50;
    club.fanConfidence = 50;
  }
  world.year += 1;
  world.dayIndex = 0;
  world.dayOfWeek = 0;
  const summary = {
    promoted: promotedAll,
    relegated: relegatedAll,
    cupChampionId: findCupWinner(world.competitions.find((c) => c.kind === "cup")!) ?? null,
    stateChampionId: world.competitions.find((c) => c.kind === "state")?.winners[0] ?? null,
  };
  for (const comp of world.competitions) {
    comp.stage = comp.kind === "cup" || comp.kind === "state" ? "group" : "group";
    comp.round = 0;
    comp.winners = [];
    comp.standings = {};
    comp.groupStandings = [];
    comp.knockouts = [];
  }
  world.fixtures = [];
  world.matches = [];
  world.auctions = [];
  world.news = [];
  for (const player of world.players) {
    player.seasonGoals = 0;
    player.seasonAssists = 0;
    player.yellows = 0;
    player.reds = 0;
    player.energy = 100;
    player.onSale = false;
    player.salePrice = null;
  }
  buildSeasonStructure(world);
  return summary;
}
