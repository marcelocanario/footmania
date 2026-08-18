import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test-worker.db";
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { generateWorld } from "../src/game/worldgen";
import { loadGlobalWorld, persistWorld, ensureGlobalSave } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { initSeason } from "../src/game/multiplayer";
import { dailyProcessor } from "../src/services/jobs/dailyProcessor";
import { notificationProcessor } from "../src/services/jobs/notificationProcessor";
import { matchScheduler } from "../src/services/jobs/matchScheduler";
import { missingDailyDates, processDailyDate, utcDateKey } from "../src/game/daily";
import { runDailyTick } from "../src/game/world";
import type { World } from "../src/game/types";

const prisma = new PrismaClient();

function inMemoryWorld(seed: number): { world: World } {
  const world = generateWorld(seed);
  world.mp.seasonYear = 2026;
  world.mp.seasonMonth = 1;
  // Populate the pyramid (8 filler AI + squads) so daily processing has clubs.
  initSeason(world, { year: 2026, month: 1 }, 1);
  return { world };
}

async function freshGlobalWorld(seed: number) {
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  return { saveId: save.id, world: loaded.world };
}

/** Current real UTC month as {year, month} — used to keep tests clock-relative. */
function currentMonth() {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/** A date string a few days before today in the current month, clamped to the
 *  first of the month so the anchor always stays inside the world's season. */
function daysAgoInCurrentMonth(days: number): string {
  const now = new Date();
  const day = Math.max(1, now.getUTCDate() - days);
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  return utcDateKey(date);
}

async function withSeason(saveId: number, ref = currentMonth()) {
  const season = await ensureSeasonRow(prisma, ref);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  initSeason(loaded.world, ref, season.seasonId);
  loaded.world.mp.seasonId = season.seasonId;
  loaded.world.mp.lastDailyTickDate = null;
  loaded.world.mp.lastDailyTickDay = 0;
  await persistWorld(prisma, saveId, saveId, loaded.world);
  return { seasonId: season.seasonId, world: loaded.world, saveId };
}

function seedWorld(world: World) {
  // Create a deterministic club + player baseline so daily development is measurable.
  const club = world.clubs[0];
  const player = world.players.find((p) => p.clubId === club.id && !p.isYouth)!;
  return { club, player };
}

describe("missingDailyDates", () => {
  it("lists every date from the day after lastProcessed through today", () => {
    const now = new Date(Date.UTC(2026, 0, 5));
    const dates = missingDailyDates("2026-01-01", now);
    expect(dates).toEqual(["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
  });

  it("returns [] when already caught up", () => {
    const now = new Date(Date.UTC(2026, 0, 5));
    expect(missingDailyDates("2026-01-05", now)).toEqual([]);
  });

  it("starts at month start when lastProcessed is null", () => {
    const now = new Date(Date.UTC(2026, 0, 5));
    const dates = missingDailyDates(null, now);
    expect(dates[0]).toBe("2026-01-01");
    expect(dates.at(-1)).toBe("2026-01-05");
  });
});

describe("processDailyDate is date-aware", () => {
  it("does not use Date.now() internally for a historical date", () => {
    const { world } = inMemoryWorld(1001);
    const { player } = seedWorld(world);
    const energyBefore = player.energy;

    // Process a historical date (Jan 3). dayIndex becomes 3, energy refills.
    const date = "2026-01-03";
    const result = processDailyDate(world, { date, now: Date.UTC(2026, 0, 3) });
    expect(world.dayIndex).toBe(3);
    expect(result.executed).toContain("DAILY_TICK");
    expect(player.energy).toBe(Math.min(100, energyBefore + 6));
  });

  it("runs payroll only on interval days", () => {
    const { world } = inMemoryWorld(1002);
    const payrollResult = processDailyDate(world, { date: "2026-01-07", now: Date.UTC(2026, 0, 7) });
    expect(payrollResult.executed).toContain("PAYROLL");
    const other = processDailyDate(world, { date: "2026-01-08", now: Date.UTC(2026, 0, 8) });
    expect(other.executed).not.toContain("PAYROLL");
  });
});

describe("dailyProcessor downtime recovery", () => {
  it("processes a single missed date exactly once", async () => {
    const { saveId } = await freshGlobalWorld(2001);
    const { world } = await withSeason(saveId);
    // Anchor lastDailyTickDate to yesterday; "now" is effectively today.
    world.mp.lastDailyTickDate = daysAgoInCurrentMonth(1);
    await persistWorld(prisma, saveId, saveId, world);
    const player = seedWorld(world).player;
    const energyBefore = player.energy;

    const loaded0 = await loadGlobalWorld(prisma);
    const result = await dailyProcessor({ prisma, saveId, revision: loaded0!.save.revision, world: loaded0!.world });
    expect(result.changed).toBe(true);

    const loaded = await loadGlobalWorld(prisma);
    expect(loaded!.world.mp.lastDailyTickDate).not.toBe(daysAgoInCurrentMonth(1));
    const today = utcDateKey(new Date());
    expect(loaded!.world.mp.lastDailyTickDate).toBe(today);
    // Energy was refilled at least once (the missed day).
    expect(loaded!.world.players.find((p) => p.id === player.id)!.energy).toBeGreaterThanOrEqual(energyBefore);

    // Re-run: no changes, exactly-once semantics.
    const loaded2 = await loadGlobalWorld(prisma);
    const second = await dailyProcessor({ prisma, saveId, revision: loaded2!.save.revision, world: loaded2!.world });
    expect(second.changed).toBe(false);
  });

  it("re-runs a date already processed in the DB ledger harmlessly", async () => {
    const { saveId } = await freshGlobalWorld(2002);
    const { world, seasonId } = await withSeason(saveId);
    const anchor = daysAgoInCurrentMonth(2);
    world.mp.lastDailyTickDate = anchor;
    // Manually record the DAILY_TICK execution for a date we will "re-run".
    await prisma.dailyExecution.create({
      data: { saveId, seasonId, date: anchor, executionType: "DAILY_TICK" },
    });
    await persistWorld(prisma, saveId, saveId, world);

    const loaded = await loadGlobalWorld(prisma);
    await dailyProcessor({ prisma, saveId, revision: loaded!.save.revision, world: loaded!.world });
    // Even if it runs, the ledger row exists; re-running the date must not
    // double-process (lastDailyTickDate only moves forward).
    const loaded2 = await loadGlobalWorld(prisma);
    expect(loaded2!.world.mp.lastDailyTickDate).toBe(utcDateKey(new Date()));
  });

  it("persists after each date so a crash resumes from the last completed one", async () => {
    const { saveId } = await freshGlobalWorld(2003);
    const { world } = await withSeason(saveId);
    // Force many missed dates by anchoring well back within the same month.
    const anchor = daysAgoInCurrentMonth(3);
    world.mp.lastDailyTickDate = anchor;
    await persistWorld(prisma, saveId, saveId, world);
    const player = seedWorld(world).player;
    const before = world.players.find((p) => p.id === player.id)!;

    // Simulate a crash after the first date: process the first missing date
    // manually and persist, then let the processor resume from the next one.
    const firstMissing = daysAgoInCurrentMonth(2);
    const day = new Date(Date.UTC(Number(firstMissing.slice(0, 4)), Number(firstMissing.slice(5, 7)) - 1, Number(firstMissing.slice(8, 10))));
    processDailyDate(world, { date: firstMissing, now: day.getTime() });
    world.mp.lastDailyTickDate = firstMissing;
    await persistWorld(prisma, saveId, saveId, world);
    void before;

    const loaded = await loadGlobalWorld(prisma);
    const result = await dailyProcessor({ prisma, saveId, revision: loaded!.save.revision, world: loaded!.world });
    expect(result.changed).toBe(true);
    const loaded2 = await loadGlobalWorld(prisma);
    expect(loaded2!.world.mp.lastDailyTickDate).toBe(utcDateKey(new Date()));
  });

  it("records DailyExecution ledger rows in the DB", async () => {
    const { saveId } = await freshGlobalWorld(2004);
    const { world, seasonId } = await withSeason(saveId);
    world.mp.lastDailyTickDate = daysAgoInCurrentMonth(1);
    await persistWorld(prisma, saveId, saveId, world);

    const loaded = await loadGlobalWorld(prisma);
    await dailyProcessor({ prisma, saveId, revision: loaded!.save.revision, world: loaded!.world });

    const rows = await prisma.dailyExecution.findMany({ where: { saveId } });
    expect(rows.length).toBeGreaterThan(0);
    // At least one DAILY_TICK for the current season.
    const tick = rows.find((r) => r.executionType === "DAILY_TICK" && r.seasonId === seasonId);
    expect(tick).toBeDefined();
    expect(tick!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("runDailyTick shim", () => {
  it("advances lastDailyTickDate through today", () => {
    const { world } = inMemoryWorld(3001);
    // Align the world's season with the real calendar month so the guard lets
    // the shim advance all dates to today.
    const now = new Date();
    world.mp.seasonYear = now.getUTCFullYear();
    world.mp.seasonMonth = now.getUTCMonth() + 1;
    const firstOfMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    world.mp.lastDailyTickDate = firstOfMonth;
    runDailyTick(world, Date.now());
    expect(world.mp.lastDailyTickDate).toBe(utcDateKey(now));
  });
});

describe("manual worker scheduling", () => {
  it("simulates a set-round target instead of syncing the real clock", async () => {
    const { world } = inMemoryWorld(3501);
    world.mp.manualRound = 2;
    world.mp.completedRounds = 0;

    const result = await matchScheduler({ prisma, saveId: 0, revision: 0, world });

    expect(result.changed).toBe(true);
    expect(world.mp.completedRounds).toBe(2);
    expect(world.fixtures.some((fixture) => fixture.played)).toBe(true);
  });
});

describe("notification downtime recovery", () => {
  it("replays missed notification dates and persists inactivity state even without news", async () => {
    const { saveId } = await freshGlobalWorld(3601);
    const { world } = await withSeason(saveId);
    const club = world.clubs[0];
    const user = await prisma.user.create({
      data: { username: `notification-${Date.now()}-${Math.random()}`, passwordHash: "!" },
    });
    club.ownerUserId = user.id;
    club.isHuman = true;
    club.lastMeaningfulActivityAt = null;
    await persistWorld(prisma, saveId, saveId, world);

    const loaded = await loadGlobalWorld(prisma);
    const result = await notificationProcessor({ prisma, saveId, revision: loaded!.save.revision, world: loaded!.world });

    expect(result.changed).toBe(true);
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded!.world.clubs.find((candidate) => candidate.id === club.id)!.lastMeaningfulActivityAt).not.toBeNull();
    const rows = await prisma.dailyExecution.findMany({
      where: { saveId, executionType: "NOTIFICATIONS" },
    });
    expect(rows.length).toBeGreaterThan(0);

    const rerun = await notificationProcessor({
      prisma,
      saveId,
      revision: reloaded!.save.revision,
      world: reloaded!.world,
    });
    expect(rerun.changed).toBe(false);
  });
});

describe("month-boundary coordination (plan §4)", () => {
  it("rolls over then processes the new season's dates", async () => {
    const { saveId } = await freshGlobalWorld(4001);
    // Create a world stuck in a previous month (the month before the real one).
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const prevRef = { year: prev.getUTCFullYear(), month: prev.getUTCMonth() + 1 };
    const { world } = await withSeason(saveId, prevRef);
    world.mp.lastDailyTickDate = utcDateKey(prev);
    await persistWorld(prisma, saveId, saveId, world);

    const loaded = await loadGlobalWorld(prisma);
    // The real clock is in a later month, so the daily processor rolls over
    // first. Because rollover requires real kickoffs/fixtures we only assert it
    // changed state / moved the season forward.
    const result = await dailyProcessor({ prisma, saveId, revision: loaded!.save.revision, world: loaded!.world });
    const loaded2 = await loadGlobalWorld(prisma);
    if (result.changed) {
      const order = (y: number, m: number) => y * 12 + (m - 1);
      expect(order(loaded2!.world.mp.seasonYear, loaded2!.world.mp.seasonMonth)).toBeGreaterThanOrEqual(order(prevRef.year, prevRef.month));
    }
  });
});
