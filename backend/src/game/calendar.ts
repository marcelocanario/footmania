import type { World } from "./types";
import { DAYS_PER_YEAR } from "./constants";

export interface DayInfo {
  dayIndex: number;
  dayOfWeek: number;
  label: string;
}

export function dayInfo(dayIndex: number): DayInfo {
  const day = ((dayIndex % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  return {
    dayIndex,
    dayOfWeek: day % 7,
    label: `Day ${day + 1}`,
  };
}

export function dateLabel(dayIndex: number): string {
  return dayInfo(dayIndex).label;
}

/** Display label for the multiplayer calendar, whose day index is 1-based. */
export function multiplayerDayLabel(dayIndex: number): string {
  return `Day ${Math.max(1, Math.trunc(dayIndex))}`;
}

export function weekdayName(dayOfWeek: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayOfWeek];
}

/** True when `dayIndex` is a multiple of `interval` (interval-trigger helper). */
export function isIntervalDay(dayIndex: number, interval: number): boolean {
  if (interval <= 0) return false;
  return dayIndex % interval === 0;
}

export function matchesOnDay(world: World, dayIndex: number): { fixtureId: number }[] {
  return world.fixtures
    .filter((f) => f.dayIndex === dayIndex)
    .map((f) => ({ fixtureId: f.id }));
}
