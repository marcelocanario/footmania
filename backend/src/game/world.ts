import type {
  Club,
  Competition,
  DayResult,
  Fixture,
  Match,
  Player,
  World,
} from "./types";
import { chance, pick } from "./rng";
import { createLiveMatchState, simulateMatch, applyMatchToPlayers, buildMatchFromState } from "./match";
import { updateStandings, emptyStandingsRow, isLeagueFinished, getPosition, sortedStandings } from "./league";
import { advanceCupRound, scheduleCupRound } from "./cup";
import {
  advanceStateKnockout,
  groupDone,
  scheduleStateKnockoutRound,
  startStateKnockout,
  updateGroupStandings,
} from "./stateChampionship";
import { dayInfo, isDayTwo, isSunday, isWeekend } from "./calendar";
import { awardCupPrizes, awardLeaguePrizes, awardStatePrizes, awardTvPositionBonuses, computeSeasonAwards, contractCycle, loanCycle, monthlyFinances, rolloverSeason, stadiumCycle, updateCareerRecords, weeklyUpdate, yearlySponsorship } from "./season";
import { aiBid, aiBuyGaps, aiBuyListings, aiSellSurplus, auctionAvailableCash, createAuction, isEligibleAuctionBidder, keepFreeAgentPool, resolveAuction } from "./transfers";
import { calcGate } from "./club";

export function nextId(world: World): number {
  return world.nextId++;
}

export function findClub(world: World, id: number): Club | undefined {
  return world.clubs.find((c) => c.id === id);
}

export function findCompetition(world: World, id: number): Competition | undefined {
  return world.competitions.find((c) => c.id === id);
}

export function fixturesForDay(world: World, dayIndex: number): Fixture[] {
  return world.fixtures.filter((f) => f.dayIndex === dayIndex && !f.played);
}

export function nextFixtureDay(world: World): number | null {
  const upcoming = world.fixtures
    .filter((f) => f.dayIndex > world.dayIndex && !f.played)
    .sort((a, b) => a.dayIndex - b.dayIndex);
  return upcoming.length > 0 ? upcoming[0].dayIndex : null;
}

function playFixture(rng: World["rng"], world: World, fixture: Fixture): Match {
  const home = findClub(world, fixture.homeClubId);
  const away = findClub(world, fixture.awayClubId);
  const servingSuspensions = new Set<number>();
  for (const p of world.players) {
    if (p.clubId === fixture.homeClubId || p.clubId === fixture.awayClubId) {
      if (p.suspendedGames > 0) servingSuspensions.add(p.id);
    }
  }
  const match: Match = {
    id: world.nextId++,
    fixtureId: fixture.id,
    competitionId: fixture.competitionId,
    homeClubId: fixture.homeClubId,
    awayClubId: fixture.awayClubId,
    homeScore: 0,
    awayScore: 0,
    penaltyWinnerId: null,
    attendance: 0,
    gateRevenue: 0,
    events: [],
    stats: { possession: [50, 50], shots: [0, 0], onGoal: [0, 0], offTarget: [0, 0], fouls: [0, 0], corners: [0, 0], yellows: [0, 0], reds: [0, 0], tackles: [0, 0], wrongPasses: [0, 0] },
    minuteEvents: [],
  };
  if (home && away) {
    const comp = findCompetition(world, fixture.competitionId);
    const sim = simulateMatch(rng, home, away, world.players, {
      competitionId: fixture.competitionId,
      fixtureId: fixture.id,
      homeNeutral: false,
      decider: fixtureNeedsDecider(world, fixture),
      compKind: comp?.kind ?? "league",
      year: world.year,
    });
    match.homeScore = sim.homeGoals;
    match.awayScore = sim.awayGoals;
    match.events = sim.match.events;
    match.stats = sim.match.stats;
    match.penaltyWinnerId = sim.match.penaltyWinnerId;
    match.penaltyScore = sim.match.penaltyScore;
    match.extraTime = sim.match.extraTime;
    const gate = calcGate(rng, home, away, comp?.kind ?? "league", world.ticketPrices[home.id]);
    match.attendance = gate.attendance;
    match.gateRevenue = gate.revenue;
    home.cash += gate.revenue;
    home.ledger.income.push({ code: 1, amount: gate.revenue, day: world.dayIndex, label: `Gate receipts (${comp?.name ?? ""})` });
  }
  fixture.played = true;
  world.matches.push(match);
  applyMatchToPlayers(match, world);
  for (const id of servingSuspensions) {
    const p = world.players.find((x) => x.id === id);
    if (p) p.suspendedGames = Math.max(0, p.suspendedGames - 1);
  }
  applyMatchToStandings(world, fixture, match);
  updateConfidence(world, match);
  return match;
}

export function fixtureNeedsDecider(world: World, fixture: Fixture): boolean {
  const comp = findCompetition(world, fixture.competitionId);
  if (!comp || (comp.kind !== "cup" && comp.kind !== "state")) return false;
  if (comp.stage !== "knockout") return false;
  const roundIndex = comp.kind === "state" ? fixture.round - 100 : fixture.round;
  const ties = comp.knockouts[roundIndex];
  if (!ties) return false;
  return ties.length === 1;
}

function createHumanLiveMatch(world: World, fixture: Fixture): Match {
  const rng = world.rng;
  const home = findClub(world, fixture.homeClubId)!;
  const away = findClub(world, fixture.awayClubId)!;
  const comp = findCompetition(world, fixture.competitionId);
  const match: Match = {
    id: world.nextId++,
    fixtureId: fixture.id,
    competitionId: fixture.competitionId,
    homeClubId: fixture.homeClubId,
    awayClubId: fixture.awayClubId,
    homeScore: 0,
    awayScore: 0,
    penaltyWinnerId: null,
    attendance: 0,
    gateRevenue: 0,
    events: [],
    stats: { possession: [50, 50], shots: [0, 0], onGoal: [0, 0], offTarget: [0, 0], fouls: [0, 0], corners: [0, 0], yellows: [0, 0], reds: [0, 0], tackles: [0, 0], wrongPasses: [0, 0] },
    minuteEvents: [],
  };
  world.matches.push(match);
  world.liveMatch = createLiveMatchState(rng, home, away, world.players, {
    matchId: match.id,
    competitionId: fixture.competitionId,
    fixtureId: fixture.id,
    homeNeutral: false,
    decider: fixtureNeedsDecider(world, fixture),
    compKind: comp?.kind ?? "league",
    year: world.year,
  });
  return match;
}

export function advance(world: World, opts?: { maxDays?: number }): DayResult {
  const rng = world.rng;
  const humanClubId = world.humanClubId;
  const maxDays = opts?.maxDays ?? 200;
  if (world.liveMatch) {
    return buildDayResult(world, [], [], undefined, false, true);
  }
  let advanced = 0;
  while (advanced < maxDays) {
    world.dayIndex++;
    world.dayOfWeek = dayInfo(world.dayIndex).dayOfWeek;
    advanced++;
    const events: string[] = [];
    processDayEvents(rng, world, events);
    const dayFixtures = fixturesForDay(world, world.dayIndex);
    if (dayFixtures.length === 0 && advanced < maxDays) {
      if (allCompetitionsFinished(world)) {
        seasonEnd(world, events);
        return buildDayResult(world, [], events, undefined, true);
      }
      continue;
    }
    const playedMatches: Match[] = [];
    let humanMatch: Match | undefined;
    for (const fixture of dayFixtures) {
      if (humanClubId !== null && (fixture.homeClubId === humanClubId || fixture.awayClubId === humanClubId)) {
        humanMatch = createHumanLiveMatch(world, fixture);
        continue;
      }
      const match = playFixture(rng, world, fixture);
      playedMatches.push(match);
    }
    if (playedMatches.length > 0) {
      events.push(`Match day: ${playedMatches.length} match(es) played`);
    }
    if (humanMatch) {
      world.pendingDayEvents = events;
      world.pendingDayMatchIds = playedMatches.map((m) => m.id);
      return buildDayResult(world, playedMatches, events, humanMatch, false, true);
    }
    return completeDay(rng, world, playedMatches, humanMatch, events);
  }
  return buildDayResult(world, [], [], undefined, false);
}

function completeDay(rng: World["rng"], world: World, playedMatches: Match[], humanMatch: Match | undefined, events: string[]): DayResult {
  for (const comp of world.competitions) {
    advanceKnockouts(rng, world, comp);
    if (comp.kind === "state" && comp.stage === "group" && groupDone(comp)) {
      startStateKnockout(rng, comp);
      const days = comp.config.knockoutDays ?? [];
      const fixtures = scheduleStateKnockoutRound(rng, comp, comp.round, days[0] ?? world.dayIndex + 7, 3);
      for (const f of fixtures) f.id = world.nextId++;
      world.fixtures.push(...fixtures);
    }
    if (comp.kind === "state" && comp.stage === "knockout" && comp.round - 100 < comp.knockouts.length) {
      const roundFixtures = world.fixtures.filter((f) => f.competitionId === comp.id && f.round === comp.round);
      const roundDone = roundFixtures.length > 0 && roundFixtures.every((f) => f.played);
      if (roundDone) {
        advanceStateKnockout(rng, comp, world.fixtures, world.matches);
        if (comp.stage === "knockout" && comp.round - 100 < comp.knockouts.length) {
          const days = comp.config.knockoutDays ?? [];
          const roundStart = days[(comp.round - 100) * 2];
          const fixtures = scheduleStateKnockoutRound(rng, comp, comp.round, roundStart ?? world.dayIndex + 7, 3);
          for (const f of fixtures) f.id = world.nextId++;
          world.fixtures.push(...fixtures);
        }
      }
    }
  }
  if (allCompetitionsFinished(world)) {
    seasonEnd(world, events);
    return buildDayResult(world, playedMatches, events, humanMatch, true);
  }
  return buildDayResult(world, playedMatches, events, humanMatch, false);
}

export function finalizeLiveMatch(world: World): DayResult {
  const rng = world.rng;
  const st = world.liveMatch;
  if (!st) return buildDayResult(world, [], [], undefined, false);
  const home = findClub(world, st.homeClubId)!;
  const away = findClub(world, st.awayClubId)!;
  const fixture = world.fixtures.find((f) => f.id === st.fixtureId);
  const match = buildMatchFromState(st, home, away, world.players);
  if (fixture) {
    const comp = findCompetition(world, fixture.competitionId);
    const gate = calcGate(rng, home, away, comp?.kind ?? "league", world.ticketPrices[home.id]);
    match.attendance = gate.attendance;
    match.gateRevenue = gate.revenue;
    home.cash += gate.revenue;
    home.ledger.income.push({ code: 1, amount: gate.revenue, day: world.dayIndex, label: `Gate receipts (${comp?.name ?? ""})` });
  }
  const existing = world.matches.find((m) => m.id === st.matchId);
  if (existing) {
    Object.assign(existing, match, { id: st.matchId });
  } else {
    world.matches.push(match);
  }
  if (fixture) fixture.played = true;
  applyMatchToPlayers(match, world);
  for (const id of st.suspensionClears ?? []) {
    const p = world.players.find((x) => x.id === id);
    if (p) p.suspendedGames = Math.max(0, p.suspendedGames - 1);
  }
  if (fixture) applyMatchToStandings(world, fixture, match);
  updateConfidence(world, match);
  world.liveMatch = null;
  const events = world.pendingDayEvents ?? [];
  world.pendingDayEvents = undefined;
  const dayMatchIds = world.pendingDayMatchIds ?? [];
  world.pendingDayMatchIds = undefined;
  const playedMatches = dayMatchIds.map((id) => world.matches.find((m) => m.id === id)).filter((m): m is Match => !!m);
  playedMatches.push(match);
  const humanMatch = match;
  const humanClubId = world.humanClubId;
  const nextHuman = world.fixtures.find((f) => !f.played && f.dayIndex === world.dayIndex && (f.homeClubId === humanClubId || f.awayClubId === humanClubId));
  if (nextHuman) {
    const next = createHumanLiveMatch(world, nextHuman);
    events.push("Match day: next match kicks off");
    world.pendingDayEvents = events;
    world.pendingDayMatchIds = playedMatches.map((m) => m.id);
    return buildDayResult(world, [], events, next, false, true);
  }
  return completeDay(rng, world, playedMatches, humanMatch, events);
}

function applyMatchToStandings(world: World, fixture: Fixture, match: Match) {
  const comp = findCompetition(world, fixture.competitionId);
  if (!comp) return;
  if (comp.kind === "league") {
    updateStandings(comp, fixture.homeClubId, fixture.awayClubId, match.homeScore, match.awayScore);
  } else if (comp.kind === "state" && comp.stage === "group") {
    updateGroupStandings(comp, fixture.homeClubId, fixture.awayClubId, match.homeScore, match.awayScore);
  }
}

function advanceKnockouts(rng: World["rng"], world: World, competition: Competition): void {
  if (competition.kind !== "cup" || competition.stage !== "knockout") return;
  const round = competition.round;
  const ties = competition.knockouts[round];
  if (!ties) return;
  const roundFixtures = world.fixtures.filter((f) => f.competitionId === competition.id && f.round === round);
  const roundDone = roundFixtures.length > 0 && roundFixtures.every((f) => f.played);
  if (!roundDone) return;
  advanceCupRound(rng, competition, world.fixtures, world.matches);
  const nextRound = competition.round;
  const alreadyScheduled = world.fixtures.some((f) => f.competitionId === competition.id && f.round === nextRound);
  if (competition.stage === "knockout" && !alreadyScheduled) {
    const days = competition.config.knockoutDays ?? [];
    const roundStart = days[nextRound * 2];
    if (roundStart !== undefined) {
      const fixtures = scheduleCupRound(rng, competition, nextRound, roundStart, 3);
      for (const f of fixtures) f.id = world.nextId++;
      world.fixtures.push(...fixtures);
    }
  }
}

function updateConfidence(world: World, match: Match) {
  const home = findClub(world, match.homeClubId);
  const away = findClub(world, match.awayClubId);
  if (!home || !away) return;
  const hGoals = match.homeScore;
  const aGoals = match.awayScore;
  const apply = (club: Club, opponent: Club, goals: number, conceded: number) => {
    let board = 0;
    if (goals > conceded) board = club.reputation <= opponent.reputation ? 5 : 3;
    else if (goals < conceded) board = club.reputation >= opponent.reputation ? -7 : -4;
    club.boardConfidence = Math.max(0, Math.min(100, club.boardConfidence + board));
    let fan = board > 0 ? 3 : board < 0 ? -4 : 0;
    fan += Math.min(3, goals);
    if (home.stateCode === away.stateCode) fan += goals > conceded ? 2 : goals === conceded ? 1 : -1;
    club.fanConfidence = Math.max(0, Math.min(100, club.fanConfidence + fan));
  };
  apply(home, away, hGoals, aGoals);
  apply(away, home, aGoals, hGoals);
}

function processDayEvents(rng: World["rng"], world: World, events: string[]) {
  const info = dayInfo(world.dayIndex);
  if (world.dayIndex === 1) {
    yearlySponsorship(world);
  }
  for (const p of world.players) {
    if (p.clubId !== null && p.energy < 100) {
      p.energy = Math.min(100, p.energy + 6);
    }
  }
  if (isDayTwo(world.dayIndex)) {
    monthlyFinances(rng, world);
    events.push("Monthly finances settled");
  }
  if (isSunday(world.dayIndex)) {
    weeklyUpdate(rng, world);
    contractCycle(rng, world);
    loanCycle(rng, world);
  }
  stadiumCycle(world);
  const aiClubs = world.clubs.filter((c) => !c.isHuman);
  if (isWeekend(world.dayIndex) && chance(rng, 10) && aiClubs.length > 0) {
    aiSellSurplus(rng, world, pick(rng, aiClubs));
  }
  if (chance(rng, 4) && aiClubs.length > 0) {
    aiBuyGaps(rng, world, pick(rng, aiClubs));
  }
  for (const club of world.clubs) {
    for (const player of world.players) {
      if (player.clubId === club.id && player.contractDays > 0) player.contractDays--;
    }
    const expiring = world.players.filter((p) => p.clubId === club.id && p.contractDays <= 60 && p.contractDays > 0);
    for (const p of expiring) {
      if (chance(rng, 3)) {
        world.news.push({ dayIndex: world.dayIndex, text: `${p.name} (${club.name}) contract expiring soon`, kind: "contract" });
        events.push(`Contract warning: ${p.name}`);
      }
    }
  }
  if (world.auctions.length < 3 && chance(rng, 15)) {
    spawnAuction(rng, world);
  }
  if (chance(rng, 8)) {
    aiBuyListings(rng, world);
  }
  if (chance(rng, 10)) {
    keepFreeAgentPool(rng, world);
  }
  resolveAuctionDeadlines(world);
  if (world.auctions.length > 0 && chance(rng, 25)) {
    aiBidDuringWindow(world);
  }
}

function spawnAuction(rng: World["rng"], world: World) {
  const sellers = world.clubs.filter((c) => !c.isHuman);
  if (sellers.length === 0) return;
  const seller = pick(rng, sellers);
  const roster = world.players.filter((p) => p.clubId === seller.id && !p.isYouth && !p.isStar && !p.onSale);
  if (roster.length === 0) return;
  const player = pick(rng, roster);
  createAuction(rng, world, player.id, seller.id, world.dayIndex + 7);
  world.news.push({ dayIndex: world.dayIndex, text: `${seller.name} put ${player.name} up for auction`, kind: "auction" });
}

function resolveAuctionDeadlines(world: World) {
  const due = world.auctions.filter((a) => a.deadlineDay <= world.dayIndex);
  for (const listing of due) {
    for (const club of world.clubs) {
      if (!isEligibleAuctionBidder(listing, club)) continue;
      const player = world.players.find((p) => p.id === listing.playerId);
      if (!player) continue;
      const bid = aiBid(world.rng, club, listing, player.value, player.position, world.players, auctionAvailableCash(world, club.id, listing.id));
      if (bid !== null) {
        listing.bids.push({ clubId: club.id, amount: bid });
      }
    }
    const winner = resolveAuction(world, listing.id);
    if (winner !== null) {
      const club = findClub(world, winner);
      const player = world.players.find((p) => p.id === listing.playerId);
      world.news.push({
        dayIndex: world.dayIndex,
        text: `${club?.name ?? "Club"} won the auction for ${player?.name ?? "a player"}`,
        kind: "auction",
      });
    }
  }
}

export function aiBidDuringWindow(world: World) {
  const open = world.auctions.filter((a) => a.deadlineDay > world.dayIndex);
  if (open.length === 0) return;
  const listing = pick(world.rng, open);
  const player = world.players.find((p) => p.id === listing.playerId);
  if (!player) return;
  const candidates = world.clubs.filter((c) => isEligibleAuctionBidder(listing, c));
  if (candidates.length === 0) return;
  const club = pick(world.rng, candidates);
  const bid = aiBid(world.rng, club, listing, player.value, player.position, world.players, auctionAvailableCash(world, club.id, listing.id));
  if (bid !== null) {
    listing.bids.push({ clubId: club.id, amount: bid });
  }
}function allCompetitionsFinished(world: World): boolean {
  if (world.competitions.length === 0) return false;
  const leagueDone = world.competitions.filter((c) => c.kind === "league").every((c) => isLeagueFinished(c, world.fixtures) && Object.values(c.standings).length > 0);
  const cupDone = world.competitions.filter((c) => c.kind === "cup").every((c) => c.stage === "finished");
  const stateDone = world.competitions.filter((c) => c.kind === "state").every((c) => c.stage === "finished");
  return leagueDone && cupDone && stateDone;
}

function seasonEnd(world: World, events: string[]) {
  let championId: number | null = null;
  let runnerUpId: number | null = null;
  for (const comp of world.competitions) {
    if (comp.kind === "league") {
      const sorted = sortedStandings(comp);
      if (sorted.length > 0) {
        const champ = findClub(world, sorted[0].clubId);
        if (champ) {
          champ.trophies[comp.name] = (champ.trophies[comp.name] ?? 0) + 1;
          events.push(`${champ.name} are champions of ${comp.name}!`);
        }
        if (championId === null) {
          championId = sorted[0].clubId;
          runnerUpId = sorted[1]?.clubId ?? null;
        }
      }
    }
  }
  awardLeaguePrizes(world);
  awardStatePrizes(world);
  awardCupPrizes(world);
  awardTvPositionBonuses(world);
  computeSeasonAwards(world);
  updateCareerRecords(world);
  const rollover = rolloverSeason(world.rng, world);
  world.seasonSummary = {
    leagueChampionId: championId,
    leagueRunnerUpId: runnerUpId,
    cupChampionId: rollover.cupChampionId,
    stateChampionId: rollover.stateChampionId,
    promoted: rollover.promoted,
    relegated: rollover.relegated,
  };
  const champ = championId !== null ? findClub(world, championId) : null;
  if (champ) {
    world.news.push({ dayIndex: 0, text: `${champ.name} are the National champions!`, kind: "title" });
  }
  world.news.push({ dayIndex: 0, text: `Season ${world.year} has begun`, kind: "season" });
}

function buildDayResult(world: World, playedMatches: Match[], events: string[], humanMatch: Match | undefined, seasonEnded: boolean, matchPending = false): DayResult {
  return {
    dayIndex: world.dayIndex,
    dateLabel: dayInfo(world.dayIndex).label,
    playedMatches,
    news: playedMatches.map((m) => {
      const home = findClub(world, m.homeClubId);
      const away = findClub(world, m.awayClubId);
      return {
        dayIndex: world.dayIndex,
        kind: "result",
        text: `${home?.name ?? "?"} ${m.homeScore} - ${m.awayScore} ${away?.name ?? "?"}`,
      };
    }),
    events,
    humanMatch,
    matchPending,
    seasonEnded,
  };
}

export function leagueTable(world: World, competitionId: number) {
  const comp = findCompetition(world, competitionId);
  if (!comp) return [];
  const rows = Object.values(comp.standings).sort((a, b) => b.points - a.points || (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst) || b.goalsFor - a.goalsFor);
  return rows.map((row) => {
    const club = findClub(world, row.clubId);
    return { ...row, clubName: club?.name ?? "", clubShort: club?.shortName ?? "" };
  });
}

export function roundLabelFor(competition: Competition, round: number): string {
  if (competition.kind === "state" && round >= 100) {
    const idx = round - 100;
    const names = ["Quarter-finals", "Semi-finals", "Final"];
    return names[idx] ?? `Knockout ${idx + 1}`;
  }
  return `Round ${round + 1}`;
}

export function competitionFixtures(world: World, competitionId: number) {
  const comp = findCompetition(world, competitionId);
  return world.fixtures
    .filter((f) => f.competitionId === competitionId)
    .sort((a, b) => a.round - b.round || (a.leg ?? 0) - (b.leg ?? 0))
    .map((f) => {
      const home = findClub(world, f.homeClubId);
      const away = findClub(world, f.awayClubId);
      const m = world.matches.find((x) => x.fixtureId === f.id);
      return {
        id: f.id,
        round: f.round,
        roundLabel: comp ? roundLabelFor(comp, f.round) : `Round ${f.round + 1}`,
        leg: f.leg ?? 1,
        homeClubId: f.homeClubId,
        awayClubId: f.awayClubId,
        home: home?.name ?? "",
        away: away?.name ?? "",
        dayIndex: f.dayIndex,
        dayLabel: dayInfo(f.dayIndex).label,
        played: f.played,
        homeScore: m?.homeScore,
        awayScore: m?.awayScore,
        isHuman: f.homeClubId === world.humanClubId || f.awayClubId === world.humanClubId,
      };
    });
}
