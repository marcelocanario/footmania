import type { ScheduledEventView } from "../../api/client";

/** "in 12m" / "overdue by 3m" / "5s ago" style relative label for a timestamp. */
export function relativeTime(iso: string | number, now = Date.now()): string {
  const diffMs = new Date(iso).getTime() - now;
  const abs = Math.abs(diffMs);
  const future = diffMs > 0;
  const mins = Math.floor(abs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let span: string;
  if (abs < 10_000) span = "moments";
  else if (mins < 1) span = `${Math.floor(abs / 1000)}s`;
  else if (mins < 60) span = `${mins}m`;
  else if (hours < 48) span = `${hours}h ${mins % 60}m`;
  else span = `${days}d`;
  return future ? `in ${span}` : `${span} ago`;
}

/** Due label for a scheduled event: real-time events get relative wall-clock times, game-day events a day index. */
export function eventDueLabel(event: Pick<ScheduledEventView, "timeBasis" | "dueAt" | "dueAbsoluteGameDay">, now = Date.now()): { primary: string; overdue: boolean; absolute?: string } {
  if (event.timeBasis === "REAL_TIME") {
    if (!event.dueAt) return { primary: "-", overdue: false };
    const due = new Date(event.dueAt).getTime();
    return {
      primary: due <= now ? `overdue ${relativeTime(event.dueAt, now)}` : relativeTime(event.dueAt, now),
      overdue: due <= now,
      absolute: new Date(event.dueAt).toLocaleString(),
    };
  }
  const day = (event.dueAbsoluteGameDay ?? 0) + 1;
  return { primary: `Day ${day}`, overdue: false, absolute: event.dueAt ? new Date(event.dueAt).toLocaleString() : undefined };
}

/** Human label for an entity reference like AUCTION:42 -> "Auction #42". */
export function entityLabel(entityType: string | null, entityId: string | null): string {
  if (!entityType) return "-";
  const pretty = entityType === "FREE_AGENT" ? "Free-agent listing" : entityType.charAt(0) + entityType.slice(1).toLowerCase().replaceAll("_", " ");
  return entityId ? `${pretty} #${entityId}` : pretty;
}
