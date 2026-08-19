import type { JobContext, JobResult } from "./runner";
import { runAiBuying, runAiFreeAgentBidding, runAiSelling } from "../../game/aiMarket";
import { divisionForClub, lowestActiveTier } from "../../game/multiplayer";
import { MARKET_CONFIG } from "../../config";
import type { World } from "../../game/types";

/**
 * AI market processor (transfer-market-overhaul Phase 5/6/7).
 *
 * Periodically evaluates AI club squads and creates public auctions for
 * surplus players (§35-§40), lets AI clubs bid on active transfer listings
 * they genuinely need (§28-§34), and lets AI clubs compete for free agents
 * (§45). The AI decides; the market service executes.
 *
 * The runner persists on change; this job only mutates the in-memory world and
 * relies on the shared revision-checked save.
 */
export async function aiMarketProcessor(ctx: JobContext): Promise<JobResult> {
  const { world } = ctx;
  const now = ctx.now ?? Date.now();

  // Division number for every AI club (1 = strongest, §102.13.3). AI filler
  // always lives inside a division, so the membership (or standings) resolves.
  const divisionByClub = new Map<number, number>();
  for (const club of world.clubs) {
    if (club.isHuman || club.ownerUserId !== null || club.competitionState !== "ACTIVE") continue;
    divisionByClub.set(club.id, divisionForClub(world, club.id));
  }
  const totalDivisions = Math.max(1, lowestActiveTier(world, world.mp.seasonId));
  // A club-to-club auction may not cross season rollover (§17). The season is
  // the current calendar month; the boundary is the start of the next.
  const seasonRolloverAt = nextMonthStart(world);

  const created = runAiSelling(world, {
    divisionByClub,
    totalDivisions,
    now,
    seasonRolloverAt,
    maxClubs: MARKET_CONFIG.aiSelling.clubsPerTick,
  });

  const bids = runAiBuying(world, {
    divisionByClub,
    totalDivisions,
    now,
    seasonRolloverAt,
    maxClubs: MARKET_CONFIG.aiBuying.clubsPerTick,
  });

  const faBids = runAiFreeAgentBidding(world, {
    now,
    maxClubs: MARKET_CONFIG.aiBuying.clubsPerTick,
  });

  if (created.length === 0 && bids.length === 0 && faBids.length === 0) return { changed: false };
  return { changed: true };
}

function nextMonthStart(world: World): number {
  const year = world.mp.seasonYear;
  const month = world.mp.seasonMonth; // 1..12
  return month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
}
