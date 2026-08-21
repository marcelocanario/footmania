import { describe, expect, it } from "vitest";
import { gameConfig, parseGameConfig } from "../src/config";
import { calendarValues, phaseForSeasonDayIndex, seasonSchedulePreview } from "../src/services/seasonCalendar";
import { nextPayrollTimestamp } from "../src/routes/game";
import { generateWorld } from "../src/game/worldgen";

describe("configurable inter-season calendar", () => {
  it("uses the default split without changing the 35-day season", () => {
    const values = calendarValues();
    expect(gameConfig.interseasonAfterMatchDays).toBe(2);
    expect(gameConfig.interseasonBeforeNextSeasonDays).toBe(5);
    expect(values.seasonDays).toBe(35);
    expect(values.interseasonStartIndex).toBe(30);
    expect(values.preparationStartIndex).toBe(30);
  });

  it("supports a different split while preserving the canonical gap and season length", () => {
    const config = { ...gameConfig, interseasonAfterMatchDays: 4, interseasonBeforeNextSeasonDays: 3 };
    const values = calendarValues(config);
    expect(values.seasonDays).toBe(35);
    expect(values.interseasonStartIndex).toBe(32);
    expect(phaseForSeasonDayIndex(28, config)).toBe("POST_MATCH");
    expect(phaseForSeasonDayIndex(31, config)).toBe("POST_MATCH");
    expect(phaseForSeasonDayIndex(32, config)).toBe("INTERSEASON");
  });

  it("rejects invalid offsets and mismatched totals", () => {
    expect(() => parseGameConfig({ ...gameConfig, interseasonAfterMatchDays: -1 })).toThrow();
    expect(() => parseGameConfig({ ...gameConfig, interseasonAfterMatchDays: 2.5 })).toThrow();
    expect(() => parseGameConfig({ ...gameConfig, interseasonAfterMatchDays: 3, interseasonBeforeNextSeasonDays: 3 })).toThrow(/must equal interseasonDays/);
  });

  it("normalizes legacy season timing to an immediate post-match transition", () => {
    const legacy = {
      ...gameConfig,
      seasonDays: 35,
      league: { ...gameConfig.league, matchIntervalDays: 2 },
    } as Record<string, unknown>;
    delete legacy.interseasonAfterMatchDays;
    delete legacy.interseasonBeforeNextSeasonDays;
    const config = parseGameConfig(legacy);
    expect(config.seasonDays).toBe(35);
    expect(config.interseasonAfterMatchDays).toBe(0);
    expect(config.interseasonBeforeNextSeasonDays).toBe(7);
  });

  it("labels both no-fixture windows from the derived phase", () => {
    const preview = seasonSchedulePreview({ ...gameConfig, interseasonAfterMatchDays: 2, interseasonBeforeNextSeasonDays: 5 });
    expect(preview.slice(28, 30).every((entry) => entry.round === null && entry.phase === "POST_MATCH")).toBe(true);
    expect(preview.slice(30).every((entry) => entry.round === null && entry.phase === "INTERSEASON")).toBe(true);
    expect(preview[28]?.label).toBe("Post-match buffer");
    expect(preview[30]?.label).toBe("Inter-season / preparation");
  });

  it("returns the following payroll date when called on a payroll day", () => {
    const world = generateWorld(7);
    const seasonStartAt = Date.UTC(2026, 0, 1);
    world.mp.seasonStartAt = seasonStartAt;
    world.mp.seasonDayIndex = 6;
    expect(nextPayrollTimestamp(world)).toBe(seasonStartAt + 13 * 24 * 60 * 60 * 1000);
  });
});
