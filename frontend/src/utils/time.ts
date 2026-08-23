/**
 * Client-side time localization (plans/9).
 *
 * The server is pure UTC: preferred match times are stored as half-hour slots
 * on the UTC grid and every timestamp travels as an epoch number or ISO string.
 * This module is the single place that converts to/from the browser's
 * auto-detected timezone so all site-wide rendering stays local.
 */

const SLOTS_PER_DAY = 48;

/** IANA name of the browser's timezone, e.g. "Europe/Berlin". */
export function userTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * Zone offset quantized to whole half-hour slots, shared by BOTH conversion
 * directions so they are exact inverses on the 48-slot ring. :45-offset zones
 * (e.g. Asia/Kathmandu) land consistently instead of drifting a slot on every
 * round trip; the residual quarter hour is absorbed by the quantization.
 */
function zoneOffsetSlots(): number {
  return Math.round(zoneOffsetMinutes(new Date(), userTimeZone()) / 30);
}

function wrapSlot(slot: number): number {
  return ((slot % SLOTS_PER_DAY) + SLOTS_PER_DAY) % SLOTS_PER_DAY;
}

/** Local half-hour slot -> UTC slot. Exact inverse of utcSlotToLocal. */
export function localSlotToUtc(slot: number): number {
  return wrapSlot(slot - zoneOffsetSlots());
}

/** UTC half-hour slot -> local slot for display. Exact inverse of localSlotToUtc. */
export function utcSlotToLocal(slot: number): number {
  return wrapSlot(slot + zoneOffsetSlots());
}

export function localSlotsToUtc(slots: number[]): number[] {
  return [...new Set(slots.map(localSlotToUtc))].sort((a, b) => a - b);
}

export function utcSlotsToLocal(slots: number[]): number[] {
  return [...new Set(slots.map(utcSlotToLocal))].sort((a, b) => a - b);
}

/**
 * Browser-local rendering for kickoff instants. Shared by every screen so
 * timestamps are formatted consistently from epoch milliseconds.
 */
export function formatKickoff(kickoffAt: number | null | undefined): string {
  if (!kickoffAt) return "";
  return new Date(kickoffAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
