import type { JobContext, JobResult } from "./runner";
import { runAiMarketTick } from "../../game/aiMarket";

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
  const now = ctx.now ?? Date.now();
  return { changed: runAiMarketTick(ctx.world, now) };
}
