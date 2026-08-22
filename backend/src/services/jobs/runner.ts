import type { PrismaClient } from "@prisma/client";
import { withGlobalLock } from "../lock";
import { loadGlobalWorldMutable, persistWorld, StaleWorldError } from "../saveService";
import type { World } from "../../game/types";

/**
 * Shared worker job runner (worker plan §1).
 *
 * Every job:
 *   1. acquires the global in-process lock (serializes all world mutations);
 *   2. loads the current global world;
 *   3. applies only its responsibility through `mutate`;
 *   4. persists with the loaded Save.revision;
 *   5. retries safely on stale revisions (another process wrote first).
 *
 * Jobs stay in the same Node process today; the optimistic-concurrency retry
 * already makes them safe to split across processes later.
 */
export interface JobContext {
  prisma: PrismaClient;
  saveId: number;
  revision: number;
  world: World;
  /** Optional wall-clock override for testability (defaults to Date.now()). */
  now?: number;
}

export interface JobResult {
  changed: boolean;
  dailyExecutions?: { seasonId: number; date: string; executionType: string }[];
  /**
   * When true the mutate body already persisted the world itself (e.g. the
   * daily processor persists after every date). The runner then skips its own
   * final persist.
   */
  persisted?: boolean;
}

/**
 * Run one job body against the live global world, persisting on change.
 * `mutate` returns a JobResult; when `changed` is true and `persisted` is not
 * set, the world is persisted once here.
 */
export async function runJob(
  prisma: PrismaClient,
  name: string,
  mutate: (ctx: JobContext) => Promise<JobResult>,
  maxRetries = 3
): Promise<{ changed: boolean }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withGlobalLock(async () => {
         const loaded = await loadGlobalWorldMutable(prisma);
        if (!loaded) return { changed: false };
        const ctx: JobContext = { prisma, saveId: loaded.save.id, revision: loaded.save.revision, world: loaded.world };
        const result = await mutate(ctx);
        if (!result.changed) return { changed: false };
        if (result.persisted) return { changed: true };
        await persistWorld(prisma, ctx.saveId, ctx.saveId, ctx.world, ctx.revision, { dailyExecutions: result.dailyExecutions });
        return { changed: true };
      });
    } catch (error) {
      if (error instanceof StaleWorldError && attempt < maxRetries) continue;
      console.error(`[job:${name}]`, error);
      throw error;
    }
  }
  return { changed: false };
}
