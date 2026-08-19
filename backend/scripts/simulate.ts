/**
 * Market-balance Monte Carlo simulation core (transfer-market-overhaul
 * Phase 11, §99).
 *
 * Runs many seeded worlds through many simulated periods and reports the §99
 * market-health metrics. This is a RESEARCH harness: it proposes adjusted
 * tunables and waits for approval — it does NOT modify any configuration
 * except through explicit `overrides` applied to the in-memory MARKET_CONFIG.
 *
 * Run: npx tsx scripts/simulate.ts [seeds] [periods]
 * Sweep: npx tsx scripts/sweep.ts [seeds] [periods]
 */
import { MARKET_CONFIG } from "../src/config";
import { generateWorld } from "../src/game/worldgen";
import { initSeason, simulateThroughRound, lowestActiveTier } from "../src/game/multiplayer";
import { runAiSelling, runAiBuying, runAiFreeAgentBidding } from "../src/game/aiMarket";
import { expireDueListings, settleDueTransferAuctions } from "../src/game/market";
import { settleDueFreeAgentListings, relistDueFreeAgents, createFreeAgentListing } from "../src/game/freeAgents";
import { contractCycle, loanCycle } from "../src/game/season";
import type { World } from "../src/game/types";

export interface SeasonMetrics {
  createdListings: number;
  sold: number;
  soldPct: number;
  saleValueRatio: number; // mean
  saleValueRatioMedian: number;
  capHits: number;
  capHitPct: number;
  capHitsByGap: Map<number, number>; // favorable gap -> count
  faListings: number;
  faSold: number;
  faValueRatio: number;
  faNoBids: number;
  loanListings: number;
  loanClaims: number;
  aiCash: number[];
  aiPayrollBurden: number[];
  aiDistress: number;
}

export interface AggregateMetrics {
  createdListings: number;
  sold: number;
  soldPct: number;
  saleValueRatio: number;
  saleValueRatioMedian: number;
  capHitPct: number;
  capHitsByGap: Map<number, number>;
  faListings: number;
  faSold: number;
  faValueRatio: number;
  faNoBids: number;
  loanListings: number;
  loanClaims: number;
  aiCash: number;
  aiPayrollBurden: number;
  aiDistress: number;
}

/** Deep-mutate MARKET_CONFIG from a flat `path.to.key = value` overrides map. */
export function applyOverrides(overrides: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split(".");
    let obj: Record<string, unknown> = MARKET_CONFIG as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = obj[parts[i]];
      if (typeof next !== "object" || next === null) throw new Error(`override path ${path}: ${parts[i]} not an object`);
      obj = next as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  }
}

function freshWorld(seed: number): World {
  const world = generateWorld(seed);
  world.mp.seasonYear = 2026;
  world.mp.seasonMonth = 1;
  initSeason(world, { year: 2026, month: 1 }, 1);
  return world;
}

function aiClubs(world: World) {
  return world.clubs.filter((c) => !c.isHuman && c.ownerUserId === null && c.competitionState === "ACTIVE");
}

function divisionByClubMap(world: World): Map<number, number> {
  const map = new Map<number, number>();
  for (const club of world.clubs) {
    if (club.isHuman || club.ownerUserId !== null) continue;
    const membership = world.mpClubSeasons.find((m) => m.clubId === club.id && m.seasonId === world.mp.seasonId);
    map.set(club.id, membership?.tier ?? 1);
  }
  return map;
}

function nextMonthStart(world: World): number {
  const month = world.mp.seasonMonth;
  const year = world.mp.seasonYear;
  return month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
}

/** One simulated market period: advance a round, run AI + settlement passes. */
function simulatePeriod(world: World, now: number, period: number) {
  const target = Math.min(world.mp.completedRounds + 1, 14);
  simulateThroughRound(world, target, now);
  world.dayIndex = Math.min(30, world.dayIndex + 1);

  const divisionByClub = divisionByClubMap(world);
  const totalDivisions = Math.max(1, lowestActiveTier(world, world.mp.seasonId));
  const rolloverAt = nextMonthStart(world);

  // Simulate contract expiries: every few periods, free a low-contract senior
  // player so the free-agent market has a steady stream of new listings.
  if (period % 4 === 0) {
    const pool = world.players.filter(
      (p) => p.clubId !== null && !p.isYouth && p.loanId === null && p.contractDays <= 60
    ).filter((p) => {
      const club = world.clubs.find((c) => c.id === p.clubId);
      return club && !club.isHuman && club.ownerUserId === null;
    });
    const target = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : undefined;
    if (target) {
      target.clubId = null;
      target.onSale = false;
      createFreeAgentListing(world, target, { now });
    }
  }

  runAiSelling(world, { divisionByClub, totalDivisions, now, seasonRolloverAt: rolloverAt, maxClubs: 0 });
  runAiBuying(world, { divisionByClub, totalDivisions, now, seasonRolloverAt: rolloverAt, maxClubs: 0 });
  runAiFreeAgentBidding(world, { now, maxClubs: 0 });

  contractCycle(world.rng, world);

  expireDueListings(world, now);
  settleDueTransferAuctions(world, now);
  settleDueFreeAgentListings(world, now);
  relistDueFreeAgents(world, now);

  loanCycle(world.rng, world);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function collectMetrics(world: World): SeasonMetrics {
  const transfers = world.transferAuctions.filter((a) => a.status === "COMPLETED");
  const createdTransfers = world.transferAuctions.filter((a) => a.status === "COMPLETED" || a.status === "CANCELLED");
  const capHits = transfers.filter((a) => a.finalPrice !== null && a.winningClubId !== null).filter((a) => {
    const bid = world.marketBids
      .filter((b) => b.listingId === a.id && b.clubId === a.winningClubId)
      .sort((x, y) => y.maxBid - x.maxBid)[0];
    return bid !== undefined && bid.maximumAllowedByRuleAtSubmission !== null && bid.maxBid >= bid.maximumAllowedByRuleAtSubmission * 0.999;
  });
  const valueRatios = transfers
    .map((a) => (a.finalPrice ?? 0) / Math.max(1, a.playerValueAtListing))
    .filter((r) => Number.isFinite(r));
  const gapMap = new Map<number, number>();
  for (const a of capHits) {
    const bid = world.marketBids
      .filter((b) => b.listingId === a.id && b.clubId === a.winningClubId)
      .sort((x, y) => y.maxBid - x.maxBid)[0];
    const gap = Math.max(0, a.sellerDivisionAtListing - (bid?.buyerDivisionAtSubmission ?? 0));
    gapMap.set(gap, (gapMap.get(gap) ?? 0) + 1);
  }

  const fas = world.freeAgentListings.filter((l) => l.status === "COMPLETED" || l.status === "CANCELLED");
  const faSold = fas.filter((l) => l.status === "COMPLETED");
  const faRatios = faSold.map((l) => (l.finalPrice ?? 0) / Math.max(1, l.playerValueAtListing)).filter(Number.isFinite);
  const faNoBids = fas.filter((l) => l.status === "CANCELLED").length;

  const loans = world.loans.filter((l) => l.toClubId !== null);
  const loanListings = world.loans.filter((l) => !l.recalled).length;

  const clubs = aiClubs(world);
  const aiCash = clubs.map((c) => c.cash);
  const aiPayroll = clubs.map((c) => {
    const payroll = world.players
      .filter((p) => p.clubId === c.id && !p.isYouth)
      .reduce((s, p) => s + p.salary, 0);
    return c.cash > 0 ? payroll / c.cash : 0;
  });
  const aiDistress = clubs.filter((c) => {
    const payroll = world.players
      .filter((p) => p.clubId === c.id && !p.isYouth)
      .reduce((s, p) => s + p.salary, 0);
    return c.cash < payroll;
  }).length;

  return {
    createdListings: createdTransfers.length,
    sold: transfers.length,
    soldPct: createdTransfers.length ? (transfers.length / createdTransfers.length) * 100 : 0,
    saleValueRatio: valueRatios.length ? valueRatios.reduce((a, b) => a + b, 0) / valueRatios.length : 0,
    saleValueRatioMedian: median(valueRatios),
    capHits: capHits.length,
    capHitPct: transfers.length ? (capHits.length / transfers.length) * 100 : 0,
    capHitsByGap: gapMap,
    faListings: fas.length,
    faSold: faSold.length,
    faValueRatio: faRatios.length ? faRatios.reduce((a, b) => a + b, 0) / faRatios.length : 0,
    faNoBids,
    loanListings,
    loanClaims: loans.length,
    aiCash,
    aiPayrollBurden: aiPayroll,
    aiDistress,
  };
}

function aggregate(metrics: SeasonMetrics[]): AggregateMetrics {
  const n = metrics.length;
  const avg = (fn: (m: SeasonMetrics) => number) => (n ? metrics.reduce((s, m) => s + fn(m), 0) / n : 0);
  const allCash = metrics.flatMap((m) => m.aiCash);
  const allBurden = metrics.flatMap((m) => m.aiPayrollBurden);
  const gapTotals = new Map<number, number>();
  for (const m of metrics) for (const [k, v] of m.capHitsByGap) gapTotals.set(k, (gapTotals.get(k) ?? 0) + v);
  return {
    createdListings: avg((m) => m.createdListings),
    sold: avg((m) => m.sold),
    soldPct: avg((m) => m.soldPct),
    saleValueRatio: avg((m) => m.saleValueRatio),
    saleValueRatioMedian: avg((m) => m.saleValueRatioMedian),
    capHitPct: avg((m) => m.capHitPct),
    capHitsByGap: gapTotals,
    faListings: avg((m) => m.faListings),
    faSold: avg((m) => m.faSold),
    faValueRatio: avg((m) => m.faValueRatio),
    faNoBids: avg((m) => m.faNoBids),
    loanListings: avg((m) => m.loanListings),
    loanClaims: avg((m) => m.loanClaims),
    aiCash: allCash.length ? allCash.reduce((a, b) => a + b, 0) / allCash.length : 0,
    aiPayrollBurden: allBurden.length ? allBurden.reduce((a, b) => a + b, 0) / allBurden.length : 0,
    aiDistress: avg((m) => m.aiDistress),
  };
}

/** Run the Monte Carlo sim and return the aggregate metrics. */
export function runSim(seeds: number, periods: number, overrides: Record<string, unknown> = {}): AggregateMetrics {
  applyOverrides(overrides);
  const metrics: SeasonMetrics[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const world = freshWorld(seed);
    const start = 1_700_000_000_000;
    const periodMs = 60 * 60 * 1000;
    for (let p = 0; p < periods; p++) {
      const now = start + p * periodMs;
      simulatePeriod(world, now, p);
      if (p > 0 && p % 14 === 0) metrics.push(collectMetrics(world));
    }
    metrics.push(collectMetrics(world));
  }
  return aggregate(metrics);
}

export function printMetrics(label: string, m: AggregateMetrics): void {
  console.log(`\n=== ${label} ===`);
  console.log(`listings created/season ${m.createdListings.toFixed(1)}`);
  console.log(`sold/season             ${m.sold.toFixed(1)} (${m.soldPct.toFixed(0)}% of created)`);
  console.log(`sale/value ratio mean   ${m.saleValueRatio.toFixed(3)}`);
  console.log(`sale/value ratio median ${m.saleValueRatioMedian.toFixed(3)}`);
  console.log(`cap-hit %               ${m.capHitPct.toFixed(1)}%`);
  const gapStr = [...m.capHitsByGap.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `gap${k}:${v}`).join(" ");
  console.log(`cap hits by gap         ${gapStr || "(none)"}`);
  console.log(`FA listings/season      ${m.faListings.toFixed(1)}`);
  console.log(`FA sold/season          ${m.faSold.toFixed(1)}`);
  console.log(`FA sale/value ratio     ${m.faValueRatio.toFixed(3)}`);
  console.log(`FA no-bid count/season  ${m.faNoBids.toFixed(1)}`);
  console.log(`loan listings/season    ${m.loanListings.toFixed(1)}`);
  console.log(`loan claims/season      ${m.loanClaims.toFixed(1)}`);
  console.log(`AI cash mean            ${m.aiCash.toFixed(0)}`);
  console.log(`AI payroll/cash mean    ${m.aiPayrollBurden.toFixed(3)}`);
  console.log(`AI distress clubs/season ${m.aiDistress.toFixed(2)}`);
}

// CLI entry: npx tsx scripts/simulate.ts [seeds] [periods]
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("simulate.ts")) {
  const seeds = Number(process.argv[2] ?? 12);
  const periods = Number(process.argv[3] ?? 48);
  printMetrics(`AGGREGATE (${seeds} seeds × ${periods} periods)`, runSim(seeds, periods));
}
