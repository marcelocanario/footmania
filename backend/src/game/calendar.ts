import type { World } from "./types";
import { DAYS_PER_YEAR, MONTH_NAMES } from "./constants";

export interface DayInfo {
  dayIndex: number;
  month: number;
  dayOfMonth: number;
  dayOfWeek: number;
  label: string;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function dayInfo(dayIndex: number): DayInfo {
  let day = ((dayIndex % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  let month = 0;
  let cum = 0;
  for (let m = 0; m < 12; m++) {
    if (day < cum + MONTH_LENGTHS[m]) {
      month = m;
      break;
    }
    cum += MONTH_LENGTHS[m];
  }
  const dayOfMonth = day - cum + 1;
  return {
    dayIndex,
    month,
    dayOfMonth,
    dayOfWeek: ((dayIndex % 7) + 7) % 7,
    label: `${MONTH_NAMES[month]} ${dayOfMonth}`,
  };
}

export function isWeekend(dayIndex: number): boolean {
  const d = ((dayIndex % 7) + 7) % 7;
  return d === 0 || d === 6;
}

export function isSunday(dayIndex: number): boolean {
  return ((dayIndex % 7) + 7) % 7 === 0;
}

export function dateLabel(dayIndex: number): string {
  return dayInfo(dayIndex).label;
}

export function weekdayName(dayOfWeek: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayOfWeek];
}

export function nextSunday(fromDay: number): number {
  let d = fromDay;
  while (!isSunday(d)) d++;
  return d;
}

export function nextWeekend(fromDay: number): number {
  let d = fromDay;
  while (!isWeekend(d)) d++;
  return d;
}

export function nextMidweek(fromDay: number): number {
  let d = fromDay;
  while (isWeekend(d)) d++;
  return d;
}

export function monthOf(dayIndex: number): number {
  return dayInfo(dayIndex).month;
}

export function isFirstOfMonth(dayIndex: number): boolean {
  return dayInfo(dayIndex).dayOfMonth === 1;
}

export function isDayTwo(dayIndex: number): boolean {
  return dayInfo(dayIndex).dayOfMonth === 2;
}

export function matchesOnDay(world: World, dayIndex: number): { fixtureId: number }[] {
  return world.fixtures
    .filter((f) => f.dayIndex === dayIndex)
    .map((f) => ({ fixtureId: f.id }));
}
