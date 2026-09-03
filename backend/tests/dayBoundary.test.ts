import { describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

import { gameConfig } from "../src/config";
import { DAY_MS, boundariesElapsed, dayBoundaryAtOrBefore, nextDayBoundaryAfter } from "../src/services/dayBoundary";

const BASE = Date.UTC(2026, 8, 2); // Sep 2 2026, 00:00 UTC

describe("day boundary", () => {
  it("snaps to the containing boundary idempotently at the default 00:00 rollover", () => {
    expect(dayBoundaryAtOrBefore(BASE)).toBe(BASE);
    expect(dayBoundaryAtOrBefore(BASE + 4 * 3600 * 1000 + 17 * 60 * 1000)).toBe(BASE);
    expect(dayBoundaryAtOrBefore(BASE + DAY_MS + 1)).toBe(BASE + DAY_MS);
    expect(dayBoundaryAtOrBefore(BASE - 1)).toBe(BASE - DAY_MS);
    const aligned = dayBoundaryAtOrBefore(BASE + 8 * 60 * 1000);
    expect(dayBoundaryAtOrBefore(aligned)).toBe(aligned);
  });

  it("honours minutes with gameDayRolloverUtc set to 06:30", () => {
    const original = gameConfig.scheduler.gameDayRolloverUtc;
    gameConfig.scheduler.gameDayRolloverUtc = "06:30";
    try {
      const boundary = Date.UTC(2026, 8, 2, 6, 30);
      expect(dayBoundaryAtOrBefore(boundary)).toBe(boundary);
      expect(dayBoundaryAtOrBefore(boundary + 60 * 60 * 1000)).toBe(boundary);
      expect(dayBoundaryAtOrBefore(boundary - 60 * 1000)).toBe(boundary - DAY_MS);
      expect(dayBoundaryAtOrBefore(boundary + DAY_MS + 123)).toBe(boundary + DAY_MS);
    } finally {
      gameConfig.scheduler.gameDayRolloverUtc = original;
    }
  });

  it("nextDayBoundaryAfter(aligned) is exactly one day later with zero seconds and ms", () => {
    const next = nextDayBoundaryAfter(BASE);
    expect(next).toBe(BASE + DAY_MS);
    const d = new Date(next);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  });

  it("counts boundaries in (from, now]", () => {
    expect(boundariesElapsed(BASE, BASE - 1)).toBe(0);
    expect(boundariesElapsed(BASE, BASE + DAY_MS - 1)).toBe(0);
    expect(boundariesElapsed(BASE, BASE + DAY_MS)).toBe(1);
    expect(boundariesElapsed(BASE, BASE + 3 * DAY_MS + 12_345)).toBe(3);
  });

  it("returns 0 for a future anchor so a launch hold never fires an advance", () => {
    // Anchor in the future (seasonBoundary = Sep 11 00:00, now = Sep 10 23:59).
    const anchor = nextDayBoundaryAfter(BASE + 8 * DAY_MS);
    expect(boundariesElapsed(anchor, anchor - 60 * 1000)).toBe(0);
    expect(boundariesElapsed(anchor, anchor + DAY_MS - 1)).toBe(0);
    expect(boundariesElapsed(anchor, anchor + DAY_MS)).toBe(1);
  });

  it("regression: an advance physically run at 04:17 still yields tomorrow's boundary", () => {
    // The day started at 00:00; the advance was deferred until 04:17. The
    // next boundary must still be tomorrow 00:00, never 04:17-based.
    const lastBoundaryAt = BASE;
    const advancedAt = BASE + 4 * 3600 * 1000 + 17 * 60 * 1000;
    expect(nextDayBoundaryAfter(lastBoundaryAt)).toBe(BASE + DAY_MS);
    // And the grid reference of the day the advance actually ran in is 00:00,
    // not 04:17 — a manual/forced advance re-anchors the same way.
    expect(dayBoundaryAtOrBefore(advancedAt)).toBe(BASE);
  });
});