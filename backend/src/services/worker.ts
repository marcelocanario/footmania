import type { PrismaClient } from "@prisma/client";
import { schedulerProcessor } from "./jobs/schedulerProcessor";
import { loadGlobalWorld } from "./saveService";

/**
 * Server-authoritative clock worker orchestrator (worker plan §1).
 *
 * The durable scheduler is the only authoritative worker path. It claims
 * timestamped events and game-day events from the database, so a restart or
 * second process cannot silently create a parallel civil-month schedule.
 */

export interface WorkerOptions {
  seasonIntervalMs?: number;
  matchIntervalMs?: number;
  auctionIntervalMs?: number;
  dailyIntervalMs?: number;
  notificationIntervalMs?: number;
  aiMarketIntervalMs?: number;
  schedulerIntervalMs?: number;
}

export function startWorker(prisma: PrismaClient, intervalMs: number, opts: WorkerOptions = {}) {
  const schedulerInterval = opts.schedulerIntervalMs ?? 10_000;

  const timers: ReturnType<typeof setInterval>[] = [];

  const schedule = (name: string, ms: number, job: () => Promise<{ changed: boolean }>) => {
    const tick = async () => {
      try {
        await job();
      } catch (error) {
        // Never crash the loop; log and continue next tick.
        console.error(`[worker:${name}]`, error);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), ms);
    timer.unref?.();
    timers.push(timer);
    return () => clearInterval(timer);
  };

  const runScheduler = async () => {
    const loaded = await loadGlobalWorld(prisma);
    if (!loaded) return { changed: false };
    return schedulerProcessor({ prisma, saveId: loaded.save.id, revision: loaded.save.revision, world: loaded.world });
  };
  const stopScheduler = schedule("scheduler", schedulerInterval, runScheduler);

  return () => {
    stopScheduler();
  };
}
