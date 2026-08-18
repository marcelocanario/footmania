import type { PrismaClient } from "@prisma/client";
import { runJob } from "./jobs/runner";
import { seasonScheduler } from "./jobs/seasonScheduler";
import { matchScheduler } from "./jobs/matchScheduler";
import { auctionProcessor } from "./jobs/auctionProcessor";
import { dailyProcessor } from "./jobs/dailyProcessor";
import { notificationProcessor } from "./jobs/notificationProcessor";

/**
 * Server-authoritative clock worker orchestrator (worker plan §1).
 *
 * Each responsibility is an independently schedulable job with its own
 * interval. Jobs all share the global in-process lock and the revision-checked
 * persist, so they serialize safely today and can be moved to separate worker
 * processes later without changing job bodies.
 *
 * The plan deliberately moves away from one giant all-purpose ticker:
 *  - seasonScheduler: month-boundary rollover + interrupted-rollover recovery;
 *  - matchScheduler: round sync, due kickoffs, live-match advancement;
 *  - auctionProcessor: minute-resolution timestamped auction settlement;
 *  - dailyProcessor: date-aware catch-up of development/payroll/contracts/etc;
 *  - notificationProcessor: inactivity warning notifications.
 */

export interface WorkerOptions {
  seasonIntervalMs?: number;
  matchIntervalMs?: number;
  auctionIntervalMs?: number;
  dailyIntervalMs?: number;
  notificationIntervalMs?: number;
}

export function startWorker(prisma: PrismaClient, intervalMs: number, opts: WorkerOptions = {}) {
  const seasonInterval = opts.seasonIntervalMs ?? intervalMs;
  const matchInterval = opts.matchIntervalMs ?? intervalMs;
  const auctionInterval = opts.auctionIntervalMs ?? Math.min(intervalMs, 5000);
  const dailyInterval = opts.dailyIntervalMs ?? Math.max(intervalMs, 60_000);
  const notificationInterval = opts.notificationIntervalMs ?? intervalMs;

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

  const stopSeason = schedule("season", seasonInterval, () => runJob(prisma, "season", seasonScheduler));
  const stopMatch = schedule("match", matchInterval, () => runJob(prisma, "match", matchScheduler));
  const stopAuctions = schedule("auctions", auctionInterval, () => runJob(prisma, "auctions", auctionProcessor));
  const stopDaily = schedule("daily", dailyInterval, () => runJob(prisma, "daily", dailyProcessor));
  const stopNotifications = schedule("notifications", notificationInterval, () => runJob(prisma, "notifications", notificationProcessor));

  return () => {
    stopSeason();
    stopMatch();
    stopAuctions();
    stopDaily();
    stopNotifications();
  };
}
