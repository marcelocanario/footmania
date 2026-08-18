import type { Player, World } from "./types";
import { chance, pick } from "./rng";
import { applyDevelopment } from "./player";
import { isIntervalDay } from "./calendar";
import { contractCycle, loanCycle, seasonEndDay, settlePayroll, stadiumCycle, weeklyUpdate, yearlySponsorship } from "./season";
import { aiBid, aiBuyGaps, aiBuyListings, aiSellSurplus, auctionAvailableCash, createAuction, isEligibleAuctionBidder, resolveAuction } from "./transfers";
import { aiBidDuringWindow } from "./world";
import { gameConfig } from "../config";
import { evaluateInactivity } from "./multiplayer";

/**
 * Date-aware daily processing (worker plan §2/§3).
 *
 * A season is one calendar month, so the in-game day-of-month equals the
 * calendar day. `processDailyDate` drives development, payroll, weekly
 * updates, contracts, loans, stadiums, inactivity evaluation and daily AI
 * activity for an explicit UTC date. It never reads `Date.now()` internally so
 * historical catch-up dates are processed faithfully.
 */

export const DAILY_TICK = "DAILY_TICK";
export const PAYROLL = "PAYROLL";
export const WEEKLY = "WEEKLY";
export const NOTIFICATIONS = "NOTIFICATIONS";

/** "YYYY-MM-DD" for a UTC instant. */
export function utcDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parse a "YYYY-MM-DD" key into the UTC start-of-day instant. */
export function parseDateKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid date key: ${key}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function isValidDateKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}

/**
 * The sequence of UTC dates from the day after `lastProcessed` through `now`
 * (inclusive), as "YYYY-MM-DD" strings. When `lastProcessed` is null the
 * sequence starts at the beginning of `now`'s calendar month so we never
 * fabricate state for months that predate the world's season.
 */
export function missingDailyDates(lastProcessed: string | null, now: Date): string[] {
  const todayKey = utcDateKey(now);
  const first = lastProcessed
    ? new Date(Date.UTC(Number(lastProcessed.slice(0, 4)), Number(lastProcessed.slice(5, 7)) - 1, Number(lastProcessed.slice(8, 10)) + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dates: string[] = [];
  const cursor = new Date(first);
  for (let guard = 0; guard < 370; guard++) {
    const key = utcDateKey(cursor);
    if (key > todayKey) break;
    dates.push(key);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

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

function spawnAuction(rng: World["rng"], world: World, now: number) {
  const sellers = world.clubs.filter((c) => c.ownerUserId === null && !c.isHuman);
  if (sellers.length === 0) return;
  const seller = pick(rng, sellers);
  const roster = world.players.filter((p) => p.clubId === seller.id && p.loanId === null && !p.isYouth && !p.onSale);
  if (roster.length === 0) return;
  const player = pick(rng, roster);
  createAuction(
    rng,
    world,
    player.id,
    seller.id,
    seasonEndDay(world.dayIndex, gameConfig.auctionDurationDays),
    now + gameConfig.auctionDurationDays * 24 * 60 * 60 * 1000,
  );
  world.news.push({ dayIndex: world.dayIndex, text: `${seller.name} put ${player.name} up for auction`, kind: "auction" });
}

function resolveAuctionDeadlines(world: World) {
  // Timestamp-backed multiplayer auctions are settled by settleDueAuctions.
  // Keep this path only for legacy listings that predate the endsAt column.
  const due = world.auctions.filter((a) => a.endsAt === undefined && a.deadlineDay <= world.dayIndex);
  for (const listing of due) {
    for (const club of world.clubs) {
      if (!isEligibleAuctionBidder(listing, club)) continue;
      const player = world.players.find((p) => p.id === listing.playerId);
      if (!player) continue;
      const bid = aiBid(world.rng, club, listing, player.value, player.position, world.players, auctionAvailableCash(world, club.id, listing.playerId));
      if (bid !== null) listing.bids.push({ clubId: club.id, amount: bid });
    }
    const winner = resolveAuction(world, listing.id);
    if (winner !== null) {
      const club = world.clubs.find((c) => c.id === winner);
      const player = world.players.find((p) => p.id === listing.playerId);
      world.news.push({ dayIndex: world.dayIndex, text: `${club?.name ?? "Club"} won the auction for ${player?.name ?? "a player"}`, kind: "auction" });
    }
  }
}

/**
 * Process a single UTC date. The world must already be positioned in the
 * correct season for `date` (the caller handles month-boundary rollover).
 * `now` is the timestamp of the date being processed (UTC start-of-day) and is
 * used only for activities that anchor to wall-clock time (inactivity).
 */
export function processDailyDate(
  world: World,
  opts: { date: string; now: number }
): DailyResult {
  const { date, now } = opts;
  const day = parseDateKey(date);
  const dayOfMonth = day.getUTCDate();
  const dayOfWeek = day.getUTCDay();

  world.dayIndex = dayOfMonth;
  world.dayOfWeek = dayOfWeek;
  world.year = world.mp.seasonYear;

  const rng = world.rng;
  const executed: string[] = [];

  // Inactivity / abandonment eligibility evaluation runs once per day.
  evaluateInactivity(world, now);
  executed.push(DAILY_TICK);

  if (world.dayIndex === 1) yearlySponsorship(world);

  for (const p of world.players) {
    if (p.clubId !== null && p.energy < 100) p.energy = Math.min(100, p.energy + 6);
  }
  dailyDevelopment(world);

  if (isIntervalDay(world.dayIndex, gameConfig.payrollIntervalDays)) {
    settlePayroll(rng, world);
    executed.push(PAYROLL);
  }
  if (isIntervalDay(world.dayIndex, gameConfig.weeklyIntervalDays)) {
    weeklyUpdate(rng, world);
    contractCycle(rng, world);
    loanCycle(rng, world);
    executed.push(WEEKLY);
  }
  stadiumCycle(world);

  const aiClubs = world.clubs.filter((c) => c.ownerUserId === null && !c.isHuman);
  if (isIntervalDay(world.dayIndex, gameConfig.transferIntervalDays) && chance(rng, 10) && aiClubs.length > 0) {
    aiSellSurplus(rng, world, pick(rng, aiClubs));
  }
  if (chance(rng, 4) && aiClubs.length > 0) {
    aiBuyGaps(rng, world, pick(rng, aiClubs));
  }

  for (const club of world.clubs) {
    if (club.competitionState !== "ACTIVE") continue;
    const warningThreshold = gameConfig.seasonDays * gameConfig.contractWarningSeasons;
    const expiring = world.players.filter((p) => p.clubId === club.id && p.contractDays <= warningThreshold && p.contractDays > 0);
    for (const p of expiring) {
      if (chance(rng, 3)) {
        world.news.push({ dayIndex: world.dayIndex, text: `${p.name} (${club.name}) contract expiring soon`, kind: "contract" });
      }
    }
  }

  if (world.auctions.length < 3 && chance(rng, 15)) spawnAuction(rng, world, now);
  if (chance(rng, 8)) aiBuyListings(rng, world);
  resolveAuctionDeadlines(world);
  if (world.auctions.length > 0 && chance(rng, 25)) aiBidDuringWindow(world, now);

  return { executed };
}
