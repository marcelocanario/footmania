import type { Club, Competition, Fixture, MpClubSeasonEntry, Player, StandingsRow, World } from "./types";
import { createLeagueFixtures, emptyStandingsRow, standingsTiebreak, sortedStandings, updateStandings } from "./league";
import { simulateMatch } from "./match";
import { kickoffForRound, seasonRefFor, seasonKey, completedRounds, joinLockRound } from "./clock";
import { gameConfig, MP_CONFIG } from "../config";
import { generateName } from "./names";
import { createRng, nextInt } from "./rng";
import { overallFromSkills } from "./rating";
import { tierBudget, proratedBudget, performanceModifier } from "./budget";
import { releaseAllReservations } from "./market";
import { generateNewClubRoster, totalDivisionsForGeneration } from "./clubGenerator";
import type { PrismaClient } from "@prisma/client";

export const CLUBS_PER_DIVISION = gameConfig.league.teams;
export const ROUNDS_PER_SEASON = gameConfig.league.turns * (gameConfig.league.teams - 1);
export const MAX_DIVISIONS_PER_TIER = (tier: number) => (tier === 1 ? 1 : 1 << (tier - 1));

/** Division name in the plan's scheme: "1", "2.1", "3.2", ... */
export function divisionName(tier: number, groupIndex: number): string {
  if (tier === 1) return "1";
  return `${tier}.${groupIndex + 1}`;
}

/** Tier of a division competition. */
export function tierOf(comp: Competition): number {
  return comp.tier ?? 1;
}

export function groupIndexOf(comp: Competition): number {
  return comp.groupIndex ?? 0;
}

/** Division name for a competition object. */
export function compDivisionName(comp: Competition): string {
  return divisionName(tierOf(comp), groupIndexOf(comp));
}

/** Child divisions of a given division (groupIndex children, binary tree). */
export function childGroupIndexes(comp: Competition): number[] {
  return [groupIndexOf(comp) * 2, groupIndexOf(comp) * 2 + 1];
}

/** Is `child` the correct child of `parent`? */
export function isChildOf(parent: Competition, child: Competition): boolean {
  return tierOf(child) === tierOf(parent) + 1 && childGroupIndexes(parent).includes(groupIndexOf(child));
}

export function clubById(world: World, id: number): Club | undefined {
  return world.clubs.find((c) => c.id === id);
}

export function divisionById(world: World, id: number): Competition | undefined {
  return world.competitions.find((c) => c.kind === "division" && c.id === id);
}

export function divisionsInSeason(world: World, seasonId: number): Competition[] {
  return world.competitions.filter((c) => c.kind === "division" && c.seasonId === seasonId);
}

export function divisionsInTier(world: World, seasonId: number, tier: number): Competition[] {
  return divisionsInSeason(world, seasonId)
    .filter((c) => tierOf(c) === tier)
    .sort((a, b) => groupIndexOf(a) - groupIndexOf(b));
}

export function membersOf(world: World, divisionId: number): { clubId: number; isFillerAI: boolean; slot: number }[] {
  const comp = divisionById(world, divisionId);
  if (!comp) return [];
  return Object.values(comp.standings)
    .map((row) => ({ clubId: row.clubId, isFillerAI: isFillerAI(world, row.clubId), slot: row.clubId }))
    .sort((a, b) => a.slot - b.slot);
}

/** True when the club is a filler AI (no owner and never had one this season). */
export function isFillerAI(world: World, clubId: number): boolean {
  const club = clubById(world, clubId);
  return club !== undefined && club.ownerUserId === null && club.isHuman === false;
}

/** True when the club is owned by a human. */
export function isHumanClub(world: World, clubId: number): boolean {
  const club = clubById(world, clubId);
  return club !== undefined && club.ownerUserId !== null;
}

/** Ranked human clubs of a division, best-first by the plan's promotion rules. */
export function humanRanking(world: World, comp: Competition): { clubId: number; rank: number }[] {
  const rows = standingsTiebreak(Object.values(comp.standings));
  const humans = rows
    .filter((r) => isHumanClub(world, r.clubId))
    .map((r, i) => ({ clubId: r.clubId, rank: i + 1 }));
  return humans;
}

export function highestRankedReplaceableAI(world: World, comp: Competition): number | null {
  const rows = standingsTiebreak(Object.values(comp.standings));
  for (const row of rows) {
    const club = clubById(world, row.clubId);
    // Never replace a filler while its scheduled match is already live. The
    // fixture may be rewritten for future rounds, but the live state holds
    // the original club ids and would otherwise produce a split-brain result.
    const inLiveMatch = world.liveMatches.some((match) => match.homeClubId === row.clubId || match.awayClubId === row.clubId);
    if (club && club.ownerUserId === null && club.isHuman === false && !inLiveMatch) return row.clubId;
  }
  return null;
}

/** Count of filler AI clubs in a division. */
export function fillerCount(world: World, comp: Competition): number {
  return Object.values(comp.standings).filter((r) => isFillerAI(world, r.clubId)).length;
}

export function humanCount(world: World, comp: Competition): number {
  return Object.values(comp.standings).filter((r) => isHumanClub(world, r.clubId)).length;
}

/** All clubs currently in the active pyramid (ACTIVE + a competition membership). */
export function activeClubs(world: World): Club[] {
  const ids = new Set<number>();
  for (const c of world.competitions) {
    if (c.kind === "division" && c.status !== "ARCHIVED") {
      for (const row of Object.values(c.standings)) ids.add(row.clubId);
    }
  }
  return world.clubs.filter((c) => ids.has(c.id));
}

export function activeDivisionForClub(world: World, clubId: number): Competition | undefined {
  return world.competitions.find((c) => c.kind === "division" && c.status !== "ARCHIVED" && c.standings[clubId] !== undefined);
}

/** Resolve the current pyramid tier, falling back to the latest known season. */
export function divisionForClub(world: World, clubId: number): number {
  const active = activeDivisionForClub(world, clubId);
  if (active) return tierOf(active);
  const history = world.mpClubSeasons
    .filter((entry) => entry.clubId === clubId)
    .sort((a, b) => b.seasonId - a.seasonId);
  return history[0]?.tier ?? 1;
}

/**
 * Record a club's division for the season it is about to play. The highest-ever
 * division reached only updates once the club actually enters a higher division
 * (lower number), never merely when promotion is secured (player-generation
 * §21). Division 1 = strongest; larger numbers are weaker.
 */
export function recordDivision(world: World, clubId: number, division: number): void {
  const club = clubById(world, clubId);
  if (club) club.highestDivision = Math.min(club.highestDivision, division);
}

/**
 * Set the first real competitive division for a newly created club. New clubs
 * receive a roster before placement, so their provisional generation context
 * must not be treated as a historical Division-1 achievement.
 */
export function recordInitialDivision(world: World, clubId: number, division: number): void {
  const club = clubById(world, clubId);
  if (!club) return;
  const creationKey = `club-creation:${clubId}`;
  const hasPriorSeason = world.mpClubSeasons.some((entry) => entry.clubId === clubId);
  if (world.generationEvents.includes(creationKey) && !hasPriorSeason) club.highestDivision = division;
  else recordDivision(world, clubId, division);
}

export function auditMultiplayerEvent(
  world: World,
  eventType: string,
  opts: { clubId?: number | null; userId?: number | null; metadata?: string } = {},
): void {
  world.mpAudits.push({
    seasonId: world.mp.seasonId || null,
    clubId: opts.clubId ?? null,
    userId: opts.userId ?? null,
    eventType,
    occurredAt: Date.now(),
    metadata: opts.metadata ?? null,
  });
}

export function lowestActiveTier(world: World, seasonId: number): number {
  const tiers = divisionsInSeason(world, seasonId).map(tierOf);
  return tiers.length === 0 ? 1 : Math.max(...tiers);
}

/** Replaceable AI slot in the first (lowest-group) division of a tier, or null. */
export function firstReplaceableAIDivision(world: World, seasonId: number, tier: number): Competition | null {
  const divs = divisionsInTier(world, seasonId, tier);
  for (const d of divs) {
    if (highestRankedReplaceableAI(world, d) !== null) return d;
  }
  return null;
}

/** Create a filler AI club with a generated squad. */
export function createFillerAI(world: World, tier: number, seasonId?: number): Club {
  const rng = world.rng;
  const id = world.nextId++;
  const city = pickCity(rng);
  const name = `${city} FC`;
  const country = "BRA";
  const club: Club = {
    id,
    name,
    shortName: name,
    ownerUserId: null,
    timezone: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country,
    highestDivision: tier,
    cash: STARTING_CASH(tier),
    stadiumName: `${city} Stadium`,
    stadiumCapacity: Math.max(10000, Math.min(60000, tier * 1100 + nextInt(rng, 15000))),
    primaryColor: "#334455",
    secondaryColor: "#112233",
    coachName: generateName(rng, country),
    tactics: randomTactics(rng),
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
  world.clubs.push(club);
  generateNewClubRoster({
    world,
    club,
    currentDivision: tier,
    highestDivisionReached: tier,
    totalDivisions: totalDivisionsForGeneration(world, seasonId),
    seasonId: (seasonId ?? world.mp.seasonId) || null,
  });
  return club;
}

function pickCity(rng: ReturnType<typeof createRng>): string {
  const cities = [
    "London", "Madrid", "Rome", "Munich", "Paris", "Lisbon", "Amsterdam", "Brussels",
    "Vienna", "Zurich", "Stockholm", "Dublin", "Warsaw", "Prague", "Budapest", "Athens",
    "Istanbul", "Kyiv", "Buenos Aires", "Montevideo", "Santiago", "Lima", "Bogota", "Mexico City",
    "New York", "Los Angeles", "Chicago", "Toronto", "Tokyo", "Seoul", "Shanghai", "Mumbai",
  ];
  return cities[nextInt(rng, cities.length)];
}

function randomTactics(rng: ReturnType<typeof createRng>) {
  const roll = nextInt(rng, 100);
  return {
    formation: roll <= 2 ? 0 : roll <= 4 ? 1 : roll <= 7 ? 2 : roll <= 38 ? 3 : roll <= 49 ? 4 : roll <= 60 ? 5 : roll <= 65 ? 6 : roll <= 72 ? 7 : roll <= 90 ? 8 : roll <= 92 ? 9 : 10,
    style: nextInt(rng, 100) <= 5 ? 2 : nextInt(rng, 100) <= 70 ? 0 : 1,
    pressing: nextInt(rng, 100) <= 70 ? 0 : 1,
    direction: nextInt(rng, 100) <= 70 ? 0 : 1,
  };
}

function STARTING_CASH(tier: number): number {
  return Math.max(1_000_000, 3_500_000 * Math.pow(0.72, Math.max(0, tier - 1)));
}

export interface SeasonContext {
  seasonId: number;
  year: number;
  month: number;
}

/** Create a new global season (competition = Division 1 with 8 filler AI). */
export function initSeason(world: World, ref: { year: number; month: number }, seasonId: number): SeasonContext {
  world.mp.seasonId = seasonId;
  world.mp.seasonYear = ref.year;
  world.mp.seasonMonth = ref.month;
  world.mp.seasonStatus = "ACTIVE";
  world.mp.completedRounds = 0;
  world.mp.joinLockRound = joinLockRound();
  world.mp.joinState = "OPEN";
  world.mp.joinThresholdPercent = MP_CONFIG.joinThresholdPercent;

  // Ensure a Division 1 exists. All pre-existing clubs stay; on first run the
  // world is empty and we create 8 filler AI clubs.
  const existing = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId);
  if (existing) {
    // Ensure fixtures exist for the division if they don't already.
    const hasFixtures = world.fixtures.some((f) => f.competitionId === existing.id);
    if (!hasFixtures && Object.keys(existing.standings).length > 0) {
      const fixtures = generateDivisionFixtures(world, existing, ref);
      world.fixtures.push(...fixtures);
    }
    return { seasonId, year: ref.year, month: ref.month };
  }

  const div = createDivision(world, { tier: 1, groupIndex: 0, seasonId, ref });
  // Fill with filler AI until 8 slots.
  ensureDivisionFull(world, div);
  const fixtures = generateDivisionFixtures(world, div, ref);
  world.fixtures.push(...fixtures);
  div.status = "ACTIVE";
  return { seasonId, year: ref.year, month: ref.month };
}

/** Create a division (competition) with empty standings + no fixtures yet. */
export function createDivision(
  world: World,
  opts: { tier: number; groupIndex: number; seasonId: number; ref: { year: number; month: number } }
): Competition {
  const id = world.nextId++;
  const comp: Competition = {
    id,
    kind: "division",
    name: divisionName(opts.tier, opts.groupIndex),
    round: 0,
    stage: "group",
    seasonId: opts.seasonId,
    tier: opts.tier,
    groupIndex: opts.groupIndex,
    status: "CREATING",
    config: { clubs: [], turns: gameConfig.league.turns, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
    standings: {},
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
  world.competitions.push(comp);
  return comp;
}

/** Division state machine (plan §57): CREATING → SIMULATING_HISTORY → ACTIVE. */
export function setDivisionState(world: World, divisionId: number, state: "CREATING" | "SIMULATING_HISTORY" | "ACTIVE" | "COMPLETE" | "ARCHIVED"): void {
  const comp = divisionById(world, divisionId);
  if (comp) comp.status = state;
}

/** Generate the 14-round schedule for a division and assign kickoff timestamps. */
export function generateDivisionFixtures(world: World, comp: Competition, ref: { year: number; month: number }): Fixture[] {
  const clubIds = Object.keys(comp.standings).map(Number);
  const fixtures = createLeagueFixtures(world.rng, comp.id, clubIds, gameConfig.league.startDay, gameConfig.league.matchIntervalDays);
  for (const f of fixtures) {
    f.id = world.nextId++;
    const round = f.round + 1;
    f.kickoffAt = kickoffForRound(ref, round);
  }
  comp.config.clubs = clubIds;
  return fixtures;
}

/** Simulate a division through the current global round (used when creating it mid-season). */
export function simulateDivisionThroughRound(world: World, comp: Competition, throughRound: number, now: number) {
  if (comp.status === "CREATING") comp.status = "SIMULATING_HISTORY";
  const fixtures = world.fixtures.filter((f) => f.competitionId === comp.id && !f.played);
  const target = Math.min(throughRound, ROUNDS_PER_SEASON);
  for (const f of fixtures) {
    const round = f.round + 1;
    if (round > target) break;
    if (world.mp.manualRound === null && f.kickoffAt !== undefined && f.kickoffAt > now) continue;
    const home = clubById(world, f.homeClubId);
    const away = clubById(world, f.awayClubId);
    if (!home || !away) continue;
    const sim = simulateMatch(world.rng, home, away, world.players, {
      competitionId: comp.id,
      fixtureId: f.id,
      homeNeutral: false,
      decider: false,
      compKind: "division",
      year: world.mp.seasonYear,
    });
    f.played = true;
    world.matches.push({
      id: world.nextId++,
      fixtureId: f.id,
      competitionId: comp.id,
      homeClubId: f.homeClubId,
      awayClubId: f.awayClubId,
      homeScore: sim.homeGoals,
      awayScore: sim.awayGoals,
      penaltyWinnerId: null,
      attendance: 0,
      gateRevenue: 0,
      events: sim.match.events,
      stats: sim.match.stats,
      extraTime: false,
      minuteEvents: [],
    });
    updateStandings(comp, f.homeClubId, f.awayClubId, sim.homeGoals, sim.awayGoals);
  }
  if (comp.status === "SIMULATING_HISTORY") comp.status = "ACTIVE";
}

/**
 * Admin manual clock: simulate every active division instantly through
 * `targetRound`, then set the season's completed-round counter and join lock.
 * This lets an admin test a full season without waiting for real kickoffs.
 * While `manualRound` stays set, the manual value is authoritative over the
 * real clock. Any in-progress live matches are discarded so the simulation
 * through the target round is consistent.
 */
export function simulateThroughRound(world: World, targetRound: number, now: number): number {
  // Manual time is forward-only. Rewinding the counter without rewinding
  // fixtures would make the persisted season claim rounds are still pending
  // after their matches have already been simulated.
  const target = Math.max(world.mp.completedRounds, Math.min(ROUNDS_PER_SEASON, Math.round(targetRound)));
  // Discard in-progress live matches: they belong to the real schedule and
  // would otherwise race with the instant simulation below.
  world.liveMatches = [];
  for (const club of world.clubs) club.liveMatchAt = null;
  const divisions = world.competitions.filter((c) => c.kind === "division" && c.status !== "ARCHIVED");
  for (const div of divisions) {
    simulateDivisionThroughRound(world, div, target, now);
  }
  world.mp.completedRounds = target;
  if (target >= world.mp.joinLockRound) world.mp.joinState = "LOCKED";
  world.mp.manualRound = target;
  return target;
}

/** Add filler AI until a division has exactly 8 clubs. */
export function ensureDivisionFull(world: World, comp: Competition): number {
  const existing = Object.keys(comp.standings).map(Number);
  const needed = CLUBS_PER_DIVISION - existing.length;
  for (let i = 0; i < needed; i++) {
    const ai = createFillerAI(world, tierOf(comp), comp.seasonId);
    comp.standings[ai.id] = emptyStandingsRow(ai.id);
  }
  return needed;
}

/** Replace a club within a division's record with a new club (AI replacement). */
export function replaceClubInDivision(world: World, comp: Competition, oldClubId: number, newClubId: number) {
  const row = comp.standings[oldClubId];
  if (!row) return;
  delete comp.standings[oldClubId];
  row.clubId = newClubId;
  comp.standings[newClubId] = row;
  comp.config.clubs = Object.keys(comp.standings).map(Number);
  recordInitialDivision(world, newClubId, tierOf(comp));
  // Historical fixtures keep their original club IDs; only future fixtures get
  // the new identity.
  for (const f of world.fixtures) {
    if (f.competitionId !== comp.id || f.played) continue;
    if (f.homeClubId === oldClubId) f.homeClubId = newClubId;
    if (f.awayClubId === oldClubId) f.awayClubId = newClubId;
  }
}

/** Remove an ephemeral filler after a human takes its competition slot. */
function retireFillerClub(world: World, clubId: number): void {
  const club = clubById(world, clubId);
  if (!club || club.ownerUserId !== null || club.isHuman) return;
  const playerIds = new Set(world.players.filter((player) => player.clubId === clubId).map((player) => player.id));
  const loanIds = new Set(world.loans.filter((loan) => loan.fromClubId === clubId || loan.toClubId === clubId).map((loan) => loan.id));
  for (const player of world.players) {
    if (player.loanId !== null && loanIds.has(player.loanId) && !playerIds.has(player.id)) {
      player.loanId = null;
      player.clubId = null;
      player.starter = false;
      player.tacPos = -1;
    }
  }
  world.players = world.players.filter((player) => !playerIds.has(player.id));
  world.loans = world.loans.filter((loan) => !loanIds.has(loan.id));
  for (const listing of world.transferAuctions) {
    if (listing.status !== "ACTIVE" || (listing.sellerClubId !== clubId && !playerIds.has(listing.playerId))) continue;
    releaseAllReservations(world, listing.id, "TRANSFER");
    listing.status = "CANCELLED";
    listing.cancelledAt = Date.now();
    const player = world.players.find((candidate) => candidate.id === listing.playerId);
    if (player) player.onSale = false;
  }
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE" || !playerIds.has(listing.playerId)) continue;
    releaseAllReservations(world, listing.id, "FREE_AGENT");
    listing.status = "CANCELLED";
    listing.completedAt = Date.now();
  }
  delete world.ticketPrices[clubId];
  world.clubs = world.clubs.filter((candidate) => candidate.id !== clubId);
}

/** Placement result for a joining human. */
export type JoinResult =
  | { kind: "active"; divisionId: number; tier: number; position: number; replacedClubId: number }
  | { kind: "provisional"; seasonKey: string };

/**
 * Place a newly created human club into the current season (before the join
 * lock) or mark it provisional for next season (plan §11/§14/§62).
 *
 * The authoritative join gate is the transactionally stored mp state
 * (completedRounds / joinState), NOT the wall clock (plan §82).
 */
export function placeNewClub(world: World, clubId: number, now: number, seasonId: number, nextSeasonRef: { year: number; month: number }): JoinResult {
  if (world.mp.completedRounds >= world.mp.joinLockRound || world.mp.joinState === "LOCKED") {
    world.mp.joinState = "LOCKED";
    clubById(world, clubId)!.competitionState = "PROVISIONAL";
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }

  const ref = { year: world.mp.seasonYear, month: world.mp.seasonMonth };
  const lowestTier = lowestActiveTier(world, seasonId);
  let division = firstReplaceableAIDivision(world, seasonId, lowestTier);
  if (!division) {
    // Create the next allowed division at the lowest tier, or the next tier.
    const divs = divisionsInTier(world, seasonId, lowestTier);
    const nextGroup = divs.length;
    if (nextGroup < MAX_DIVISIONS_PER_TIER(lowestTier)) {
      division = createDivision(world, { tier: lowestTier, groupIndex: nextGroup, seasonId, ref });
    } else {
      const newTier = lowestTier + 1;
      division = createDivision(world, { tier: newTier, groupIndex: 0, seasonId, ref });
    }
    ensureDivisionFull(world, division);
    const fixtures = generateDivisionFixtures(world, division, ref);
    world.fixtures.push(...fixtures);
    simulateDivisionThroughRound(world, division, world.mp.completedRounds, now);
  }

  const aiId = highestRankedReplaceableAI(world, division);
  if (aiId === null) {
    // Shouldn't happen after fill + simulation; fall back to provisional.
    clubById(world, clubId)!.competitionState = "PROVISIONAL";
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }
  const ai = clubById(world, aiId)!;
  const position = positionInDivision(world, division, aiId);
  replaceClubInDivision(world, division, aiId, clubId);
  const club = clubById(world, clubId)!;
  retireFillerClub(world, aiId);
  club.competitionState = "ACTIVE";
  // The human club inherits only current-season competition state; it keeps
  // its own identity, roster, finances, facilities.
  world.news.push({ dayIndex: world.dayIndex, text: `${club.name} joined ${division.name}`, kind: "mp", clubId: club.id });
  return { kind: "active", divisionId: division.id, tier: tierOf(division), position, replacedClubId: aiId };
}

function positionInDivision(world: World, comp: Competition, clubId: number): number {
  const rows = standingsTiebreak(Object.values(comp.standings));
  const idx = rows.findIndex((r) => r.clubId === clubId);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * Re-activate a DORMANT club (plan §46/§48). Before the join lock the club is
 * placed into the lowest active division with a replaceable AI slot (it does
 * not reclaim its historical tier). After the lock it becomes PROVISIONAL and
 * is queued for the next season. It never receives a new-club startup package.
 */
export function returnDormantClub(world: World, clubId: number, now: number, seasonId: number, nextSeasonRef: { year: number; month: number }): JoinResult {
  const club = clubById(world, clubId);
  if (!club || club.competitionState !== "DORMANT") {
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }
  if (world.mp.completedRounds >= world.mp.joinLockRound || world.mp.joinState === "LOCKED") {
    world.mp.joinState = "LOCKED";
    club.competitionState = "PROVISIONAL";
    club.abandonmentEligibleAt = null;
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }

  const ref = { year: world.mp.seasonYear, month: world.mp.seasonMonth };
  const lowestTier = lowestActiveTier(world, seasonId);
  let division = firstReplaceableAIDivision(world, seasonId, lowestTier);
  if (!division) {
    const divs = divisionsInTier(world, seasonId, lowestTier);
    const nextGroup = divs.length;
    if (nextGroup < MAX_DIVISIONS_PER_TIER(lowestTier)) {
      division = createDivision(world, { tier: lowestTier, groupIndex: nextGroup, seasonId, ref });
    } else {
      const newTier = lowestTier + 1;
      division = createDivision(world, { tier: newTier, groupIndex: 0, seasonId, ref });
    }
    ensureDivisionFull(world, division);
    const fixtures = generateDivisionFixtures(world, division, ref);
    world.fixtures.push(...fixtures);
    simulateDivisionThroughRound(world, division, world.mp.completedRounds, now);
  }

  const aiId = highestRankedReplaceableAI(world, division);
  if (aiId === null) {
    club.competitionState = "PROVISIONAL";
    club.abandonmentEligibleAt = null;
    return { kind: "provisional", seasonKey: seasonKey(nextSeasonRef) };
  }
  const position = positionInDivision(world, division, aiId);
  replaceClubInDivision(world, division, aiId, clubId);
  retireFillerClub(world, aiId);
  club.competitionState = "ACTIVE";
  club.abandonmentEligibleAt = null;
  club.lastMeaningfulActivityAt = Date.now();
  world.news.push({ dayIndex: world.dayIndex, text: `${club.name} returned to the pyramid in ${division.name}`, kind: "mp", clubId: club.id });
  return { kind: "active", divisionId: division.id, tier: tierOf(division), position, replacedClubId: aiId };
}

// ---------------------------------------------------------------------------
// Rollover / promotion / relegation (plan §23-§35, §58-§61)
// ---------------------------------------------------------------------------

export interface TierAssignment {
  clubId: number;
  targetTier: number;
  finishPosition: number;
  previousDivision: string;
}

/** Record a meaningful-activity audit row (plan §40/§55) and refresh the club's
 *  last activity timestamp used by abandonment evaluation. */
export function recordActivity(world: World, userId: number, clubId: number, activityType: string, metadata?: string): void {
  const now = Date.now();
  world.mpActivities.push({ userId, clubId, activityType, occurredAt: now, metadata: metadata ?? null });
  const club = clubById(world, clubId);
  if (club) {
    club.lastMeaningfulActivityAt = now;
    club.abandonmentEligibleAt = null;
  }
}

/** Inactivity threshold (days) for a club's current tier (plan §41). */
export function inactivityThresholdFor(world: World, clubId: number): number {
  const club = clubById(world, clubId);
  if (!club) return MP_CONFIG.inactivityThresholds.default;
  const division = activeDivisionForClub(world, clubId);
  const tier = division ? tierOf(division) : 1;
  const byTier = MP_CONFIG.inactivityThresholds;
  return byTier[tier as keyof typeof byTier] ?? byTier.default;
}

/**
 * Daily abandonment evaluation (plan §40/§42). Clubs that have not had a
 * meaningful action within their tier's threshold are flagged
 * `abandonmentEligibleAt`; meaningful activity clears the flag. Clubs are
 * NEVER removed mid-season — the flag is only consumed at rollover.
 */
export function evaluateInactivity(world: World, now: number): void {
  for (const club of world.clubs) {
    if (club.ownerUserId === null) continue;
    if (club.competitionState !== "ACTIVE") continue;
    const thresholdDays = inactivityThresholdFor(world, club.id);
    const last = club.lastMeaningfulActivityAt;
    if (last === null) {
      // No recorded activity yet: treat club creation as the anchor.
      club.lastMeaningfulActivityAt = now;
      continue;
    }
    const daysInactive = (now - last) / (24 * 60 * 60 * 1000);
    if (daysInactive >= thresholdDays) {
      if (club.abandonmentEligibleAt === null) {
        club.abandonmentEligibleAt = now;
        world.news.push({ dayIndex: world.dayIndex, text: `${club.name} has been inactive and may be removed at season end`, kind: "mp", clubId: club.id });
      }
    } else {
      club.abandonmentEligibleAt = null;
    }
  }
}

/**
 * Rebuild the normalized per-division membership list for the active season
 * from the live standings. Memberships are disposable between seasons and
 * always derived from the current pyramid state (plan §55).
 */
export function syncMemberships(world: World, seasonId: number): void {
  world.mpMemberships = [];
  const divs = divisionsInSeason(world, seasonId).filter((c) => c.status !== "ARCHIVED");
  for (const comp of divs) {
    const rows = standingsTiebreak(Object.values(comp.standings));
    rows.forEach((row, i) => {
      const club = clubById(world, row.clubId);
      world.mpMemberships.push({
        divisionId: comp.id,
        clubId: row.clubId,
        slotNumber: i + 1,
        isFillerAI: club !== undefined && club.ownerUserId === null && club.isHuman === false,
        replacedClubId: null,
        joinedAt: Date.now(),
      });
    });
  }
}

/**
 * Upsert the per-club-per-season competition records (plan §55). Entries are
 * keyed by (clubId, seasonId); stale entries for the season are replaced.
 */
export function syncClubSeasons(world: World, seasonId: number): void {
  const keep = new Set<number>();
  const divs = divisionsInSeason(world, seasonId).filter((c) => c.status !== "ARCHIVED");
  for (const comp of divs) {
    const rows = standingsTiebreak(Object.values(comp.standings));
    for (const row of rows) {
      const club = clubById(world, row.clubId);
      const entry: MpClubSeasonEntry = {
        clubId: row.clubId,
        seasonId,
        divisionId: comp.id,
        tier: tierOf(comp),
        played: row.played,
        wins: row.wins,
        draws: row.draws,
        losses: row.losses,
        goalsFor: row.goalsFor,
        goalsAgainst: row.goalsAgainst,
        points: row.points,
        promotionStatus: "NONE",
        relegationStatus: "NONE",
      };
      const existing = world.mpClubSeasons.find((e) => e.clubId === row.clubId && e.seasonId === seasonId);
      if (existing) Object.assign(existing, entry);
      else world.mpClubSeasons.push(entry);
      keep.add(row.clubId);
    }
  }
  world.mpClubSeasons = world.mpClubSeasons.filter((e) => e.seasonId !== seasonId || keep.has(e.clubId));
}

export function computeNextTierAssignments(world: World, seasonId: number): {
  assignments: Map<number, number>;
  activeClubIds: number[];
  abandonedClubIds: number[];
} {
  const divisions = divisionsInSeason(world, seasonId).filter((c) => c.status !== "ARCHIVED");
  const assignments = new Map<number, number>();
  const abandoned = new Set<number>();
  const active = new Set<number>();

  // Phase 4-5: identify abandoned clubs. A club is abandoned for the NEXT
  // season if it was marked abandonment-eligible during the season OR it is
  // already DORMANT (plan §42/§45). Ordinary filler AI (no owner) is never a
  // persistent club and is handled separately. PROVISIONAL clubs are queued
  // for next season and are not part of this season's pyramid yet.
  for (const club of world.clubs) {
    if (club.ownerUserId === null) continue;
    if (club.competitionState === "DORMANT" || club.abandonmentEligibleAt !== null) abandoned.add(club.id);
    else if (club.competitionState === "ACTIVE") active.add(club.id);
  }

  // Determine target tier for every club that remains active.
  // Top-down cascade: promotions bubble up; relegations push down.
  const byTier = new Map<number, Competition[]>();
  for (const d of divisions) {
    const t = tierOf(d);
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t)!.push(d);
  }
  const tiers = [...byTier.keys()].sort((a, b) => a - b);
  const maxTier = tiers.length > 0 ? Math.max(...tiers) : 1;

  // Track how many humans occupy each target tier (for compaction below).
  const tierOccupancy = new Map<number, number>();

  // Relegations: bottom `relegated` of each non-bottom division go down one.
  for (const d of divisions) {
    const t = tierOf(d);
    if (t >= maxTier) continue; // bottom tier has no relegation target
    const rows = standingsTiebreak(Object.values(d.standings));
    const relegateCount = d.config.relegated ?? 2;
    const doomed = rows.slice(-relegateCount).filter((r) => active.has(r.clubId));
    for (const r of doomed) {
      assignments.set(r.clubId, t + 1);
      tierOccupancy.set(t + 1, (tierOccupancy.get(t + 1) ?? 0) + 1);
    }
  }

  // Promotions: best eligible humans from child divisions.
  // For each parent tier (ascending), collect promotion candidates from its
  // children and fill the parent's promotion slots (from humans only).
  // Cascading: when a child's best humans promote, that child creates
  // vacancies that the tier below fills next (plan §34).
  for (let t = maxTier - 1; t >= 1; t--) {
    const parents = byTier.get(t) ?? [];
    const children = byTier.get(t + 1) ?? [];
    for (const parent of parents) {
      // Existing members that stay get tier t (unless relegated above).
      const existingHuman = Object.keys(parent.standings)
        .map(Number)
        .filter((id) => active.has(id) && isHumanClub(world, id));
      for (const id of existingHuman) {
        if (!assignments.has(id)) {
          assignments.set(id, t);
          tierOccupancy.set(t, (tierOccupancy.get(t) ?? 0) + 1);
        }
      }
      // Vacancies are actual departing slots, not "non-human" slots. Filler
      // AI remains in place at the bottom edge; counting it as an opening
      // would incorrectly promote enough humans to replace every AI in the
      // parent division.
      const stayingMembers = Object.values(parent.standings).filter((row) => {
        const id = row.clubId;
        return !abandoned.has(id) && (assignments.get(id) ?? t) === t;
      }).length;
      const openings = Math.max(0, CLUBS_PER_DIVISION - stayingMembers);
      const myChildren = children.filter((c) => isChildOf(parent, c));
      const candidatesByChild = myChildren.map((c) => standingsTiebreak(Object.values(c.standings))
        .filter((r) => active.has(r.clubId) && isHumanClub(world, r.clubId) && !assignments.has(r.clubId))
        .map((r, i) => ({ clubId: r.clubId, rank: i + 1, division: c, row: r })));
      // When both children exist, reserve one promotion for each child before
      // ranking any second candidates. With one child, its top two naturally
      // fill both slots (plan §25/§26).
      let promoted = 0;
      const promotedIds = new Set<number>();
      const reserveOnePerChild = candidatesByChild
        .map((candidatesForChild) => candidatesForChild[0])
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
      const orderedCandidates = [
        ...reserveOnePerChild,
        ...candidatesByChild.flatMap((candidatesForChild) => candidatesForChild.slice(1)),
      ];
      for (const cand of orderedCandidates) {
        if (promoted >= openings) break;
        if (promotedIds.has(cand.clubId)) continue;
        assignments.set(cand.clubId, t);
        promotedIds.add(cand.clubId);
        tierOccupancy.set(t, (tierOccupancy.get(t) ?? 0) + 1);
        promoted++;
      }
    }
  }

  // Phase 8 (plan §32/§33): extra promotions from abandonment vacancies use a
  // deterministic cross-division ranking among the immediate lower tier. These
  // are additional upward moves that the per-parent loop already handles when
  // openings exceed the normal two; this block is intentionally a no-op because
  // `openings` already counts abandoned departures. Kept explicit for clarity.

  // Any remaining active humans without a tier stay at their current tier.
  for (const d of divisions) {
    const t = tierOf(d);
    for (const row of Object.values(d.standings)) {
      const id = row.clubId;
      if (active.has(id) && !assignments.has(id)) {
        assignments.set(id, t);
        tierOccupancy.set(t, (tierOccupancy.get(t) ?? 0) + 1);
      }
    }
  }

  // Phase (plan §35): pyramid compaction. If the top tier is under-populated
  // with humans and the tier below has enough humans, compaction is applied
  // ONLY within each tier's grouping at rebuild time (we never arbitrarily
  // promote a club to eliminate AI). The assignment map itself is the compact
  // representation: each tier gets every active human that belongs to it, and
  // the caller regroups by human count. Nothing further to do here.

  // Validate promotion invariants (plan §60).
  const validationErrors = validateAssignments(assignments, abandoned, active);
  if (validationErrors.length > 0) {
    throw new Error(`Promotion invariants violated: ${validationErrors.join("; ")}`);
  }

  return { assignments, activeClubIds: [...active], abandonedClubIds: [...abandoned] };
}

/**
 * Validate the promotion invariants from plan §60 before committing. Throws a
 * descriptive error so rollover fails rather than silently corrupting the
 * pyramid.
 */
function validateAssignments(assignments: Map<number, number>, abandoned: Set<number>, active: Set<number>): string[] {
  const errors: string[] = [];
  const tiersSeen = new Map<number, number>();
  for (const [clubId, tier] of assignments) {
    if (abandoned.has(clubId)) errors.push(`abandoned club ${clubId} was assigned a tier`);
    if (!active.has(clubId)) errors.push(`inactive/non-owner club ${clubId} was assigned a tier`);
    if (tiersSeen.has(clubId)) errors.push(`club ${clubId} assigned to >1 tier`);
    tiersSeen.set(clubId, tier);
  }
  for (const clubId of active) {
    if (!assignments.has(clubId)) errors.push(`active human ${clubId} missing a target tier`);
  }
  return errors;
}

function crossDivisionTiebreak(a: StandingsRow, b: StandingsRow): number {
  if (b.points !== a.points) return b.points - a.points;
  const gdA = a.goalsFor - a.goalsAgainst;
  const gdB = b.goalsFor - b.goalsAgainst;
  if (gdB !== gdA) return gdB - gdA;
  if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
  if (b.wins !== a.wins) return b.wins - a.wins;
  return a.clubId - b.clubId;
}

export function timezoneCoordinate(tz: string | null): number {
  // Approximate IANA -> longitude-derived hour coordinate for clustering.
  // Falls back to UTC+0. Kept simple: sort roughly by UTC offset without DST.
  const offset = utcOffsetHours(tz);
  return offset;
}

const TZ_OFFSET_CACHE = new Map<string, number>();

function utcOffsetHours(tz: string | null): number {
  if (!tz) return 0;
  const cached = TZ_OFFSET_CACHE.get(tz);
  if (cached !== undefined) return cached;
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    const parts = fmt.formatToParts(now);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
    let hours = 0;
    if (m) {
      hours = Number(m[2]) + (Number(m[3] ?? "0") / 60);
      if (m[1] === "-") hours = -hours;
    }
    TZ_OFFSET_CACHE.set(tz, hours);
    return hours;
  } catch {
    TZ_OFFSET_CACHE.set(tz, 0);
    return 0;
  }
}

/**
 * Rebuild divisions for a tier from a set of humans, maximizing human density
 * first and then minimizing timezone spread (plan §36). Only the final
 * incomplete bottom division receives filler AI.
 */
export function rebuildTierDivisions(
  world: World,
  seasonId: number,
  tier: number,
  humans: { clubId: number; timezone: string | null }[],
  ref: { year: number; month: number }
): Competition[] {
  // Remove existing divisions at this tier.
  const old = divisionsInTier(world, seasonId, tier);
  for (const c of old) {
    world.competitions = world.competitions.filter((x) => x.id !== c.id);
    world.fixtures = world.fixtures.filter((f) => f.competitionId !== c.id);
  }

  const required = Math.max(1, Math.ceil(humans.length / CLUBS_PER_DIVISION));
  const groups = timezoneCluster(humans, required);

  const created: Competition[] = [];
  for (let g = 0; g < groups.length; g++) {
    const div = createDivision(world, { tier, groupIndex: g, seasonId, ref });
    for (const h of groups[g]) {
      div.standings[h.clubId] = emptyStandingsRow(h.clubId);
      clubById(world, h.clubId)!.competitionState = "ACTIVE";
    }
    // AI filler only in the final incomplete group.
    if (g === groups.length - 1) ensureDivisionFull(world, div);
    const fixtures = generateDivisionFixtures(world, div, ref);
    world.fixtures.push(...fixtures);
    div.status = "ACTIVE";
    created.push(div);
  }
  return created;
}

/**
 * Partition humans into `required` groups of up to 8, maximizing human density
 * (always fill a division before starting another) and then minimizing
 * timezone spread (plan §6/§36). Implementation: sort by timezone coordinate,
 * cut into contiguous chunks of 8, then greedily swap boundary members between
 * neighboring groups whenever the swap strictly reduces total timezone spread.
 * Group count never increases; only the final group may be partial (AI fills it).
 */
export function timezoneCluster(
  humans: { clubId: number; timezone: string | null }[],
  required: number
): { clubId: number; timezone: string | null }[][] {
  const groups: { clubId: number; timezone: string | null }[][] = [];
  for (let i = 0; i < required; i++) groups.push([]);

  const sorted = [...humans].sort((a, b) => timezoneCoordinate(a.timezone) - timezoneCoordinate(b.timezone));
  // Fill groups of 8 in timezone order (human density first).
  sorted.forEach((h, i) => {
    const g = Math.min(required - 1, Math.floor(i / CLUBS_PER_DIVISION));
    groups[g].push(h);
  });

  // Boundary-swap optimization: swapping the last member of group i with the
  // first member of group i+1 reduces total spread only if it moves each club
  // closer to its new group's midpoint.
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < groups.length - 1; i++) {
      const left = groups[i];
      const right = groups[i + 1];
      if (left.length === 0 || right.length === 0) continue;
      const leftMid = midpoint(left);
      const rightMid = midpoint(right);
      const leftEdge = coordOf(left[left.length - 1]);
      const rightEdge = coordOf(right[0]);
      // Distance each currently contributes to its group's spread.
      const current = Math.abs(leftEdge - leftMid) + Math.abs(rightEdge - rightMid);
      // If swapped.
      const swapped = Math.abs(rightEdge - leftMid) + Math.abs(leftEdge - rightMid);
      if (swapped < current - 1e-9) {
        // Move the boundary members: left's last member goes to right's front,
        // right's first member goes to left's back. This keeps both groups
        // contiguous in timezone order and preserves group sizes when the two
        // groups are equal-length; a size imbalance (density ordering) is only
        // allowed toward the higher-populated group.
        const leftMember = left.pop()!;
        const rightMember = right.shift()!;
        left.push(rightMember);
        right.unshift(leftMember);
        improved = true;
      }
    }
  }
  return groups;
}

function coordOf(h: { timezone: string | null }): number {
  return timezoneCoordinate(h.timezone);
}

function midpoint(humans: { timezone: string | null }[]): number {
  if (humans.length === 0) return 0;
  return humans.reduce((sum, h) => sum + coordOf(h), 0) / humans.length;
}

/** Reset a division's standings for a new season. */
export function resetDivisionStandings(world: World, comp: Competition) {
  for (const key of Object.keys(comp.standings)) {
    comp.standings[Number(key)] = emptyStandingsRow(Number(key));
  }
}

// ---------------------------------------------------------------------------
// Seasonal budget issuance
// ---------------------------------------------------------------------------

export async function issueSeasonBudget(
  prisma: PrismaClient,
  world: World,
  clubId: number,
  seasonId: number,
  tier: number,
  opts: { type: "ACTIVE_FULL" | "ACTIVE_PRORATED" | "PROVISIONAL_NEXT_SEASON"; remainingRounds?: number; finishPosition?: number; divisionSize?: number }
): Promise<number> {
  const existing = world.seasonAllocations.find((a) => a.clubId === clubId && a.seasonId === seasonId && a.type === opts.type);
  if (existing) return existing.amount;

  let full = await tierBudget(prisma, tier);
  if (opts.finishPosition !== undefined && opts.divisionSize !== undefined) {
    full = Math.round(full * performanceModifier(opts.finishPosition, opts.divisionSize));
  }
  let amount = full;
  if (opts.type === "ACTIVE_PRORATED") {
    amount = proratedBudget(full, opts.remainingRounds ?? ROUNDS_PER_SEASON, ROUNDS_PER_SEASON);
  }
  const club = clubById(world, clubId);
  if (club) {
    club.cash += amount;
    club.ledger.income.push({ code: 13, amount, day: world.dayIndex, label: `Season ${seasonKeyFromId(seasonId)} budget` });
    world.news.push({ dayIndex: world.dayIndex, text: `${club.name} received the season budget`, kind: "finance", clubId });
  }
  world.seasonAllocations.push({ clubId, seasonId, type: opts.type, amount, issuedAt: Date.now() });
  return amount;
}

function seasonKeyFromId(seasonId: number): string {
  return `#${seasonId}`;
}

/**
 * Play a non-persistent practice/friendly match (plan §15). Provisional clubs
 * use this to stay engaged. It generates NO league points, NO permanent player
 * development/XP, NO prize money, NO injuries and NO disciplinary consequences:
 * the match is simulated in memory and only the scoreline is returned.
 */
export function playPracticeMatch(world: World, clubId: number): { homeGoals: number; awayGoals: number; events: number; opponentName: string } | null {
  const club = clubById(world, clubId);
  if (!club || club.competitionState !== "PROVISIONAL") return null;
  const opponents = world.clubs.filter((c) => c.id !== clubId && c.ownerUserId === null && c.competitionState === "ACTIVE");
  if (opponents.length === 0) return null;
  const rng = { ...world.rng };
  const opponent = opponents[nextInt(rng, opponents.length)];
  // The match engine mutates player objects while it simulates fatigue,
  // injuries and goals. Practice is explicitly non-persistent, so run it on
  // isolated copies and only keep the random stream/activity record.
  const copyPlayer = (player: Player): Player => ({
    ...player,
    skills: { ...player.skills },
    skillAcc: [...player.skillAcc],
    recentMinutes: [...player.recentMinutes],
    developmentProfile: { ...player.developmentProfile },
  });
  const practicePlayers = world.players.map(copyPlayer);
  const copyClub = (source: Club): Club => ({
    ...source,
    tactics: { ...source.tactics },
    ledger: { income: [], expense: [] },
    trophies: { ...source.trophies },
    savedLineup: undefined,
  });
  const sim = simulateMatch(rng, copyClub(club), copyClub(opponent), practicePlayers, {
    competitionId: -1,
    fixtureId: -1,
    homeNeutral: false,
    decider: false,
    compKind: "division",
    year: world.mp.seasonYear,
  });
  // Deliberately NOT applying applyMatchToPlayers: practice results are
  // non-persistent and must not farm progression (plan §15).
  return { homeGoals: sim.homeGoals, awayGoals: sim.awayGoals, events: sim.match.events.length, opponentName: opponent.name };
}

export { overallFromSkills };
