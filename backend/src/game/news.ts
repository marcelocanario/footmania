import type { NewsEntry, NewsItem, World } from "./types";
import { msg, isMessageRef, type MessageKey, type MessageRef } from "../i18n/catalog";

/**
 * Central dashboard news service.
 *
 * All player-facing news is published through `publishNews`. Items carrying a
 * `subject` are grouped: publishing on the same season day, for the same
 * audience and subject, merges into the existing message instead of creating
 * a new feed row (contract expiries, academy moves, injuries…). Items without
 * a subject never merge — MOTDs, one-off reports and legacy rows.
 *
 * Localization: a grouped item's `body` is a FRAME key (e.g. `news.injuries`)
 * and the client composes `t(k.lead) + Intl.ListFormat(entries) + t(k.tail)`.
 * Each entry's `label`/`detail` is a `Displayable` — a proper name (passed
 * through untranslated) or a `MessageRef` with raw params the client formats.
 * Ungrouped text items carry a direct `MessageRef` in `body`. The legacy
 * English `text` column stays populated only where it is still the fallback
 * (MOTD, the pre-season report, and historical rows); key-native items store
 * an empty string and the client renders from `body`.
 *
 * Grouping is a domain invariant and therefore lives here, not in config; no
 * balance tunables exist in this module.
 */

/** Compact currency formatter, kept for the (still English) pre-season report. */
export function formatMoney(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(amount % 1_000_000 === 0 ? 0 : 2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount}`;
}

/** Grouping subjects. Values are stable persisted keys — never rename. */
export const NEWS_SUBJECTS = {
  contractWarning: "contract-warning",
  contractExpiry: "contract-expiry",
  contractRenewal: "contract-renewal",
  academy: "academy",
  injuries: "injuries",
  loans: "loans",
  transfers: "transfers",
  finance: "finance",
  tribunal: "tribunal",
  tactics: "tactics",
  retirement: "retirement",
  clubStatus: "club-status",
  preseasonReport: "preseason-report",
} as const;

/** Frame key selected for a grouped subject. */
const FRAME_BY_SUBJECT: Record<string, MessageKey> = {
  [NEWS_SUBJECTS.contractWarning]: "news.contract.warning",
  [NEWS_SUBJECTS.contractExpiry]: "news.contract.expiry",
  [NEWS_SUBJECTS.contractRenewal]: "news.contract.renewal",
  [NEWS_SUBJECTS.academy]: "news.academy",
  [NEWS_SUBJECTS.injuries]: "news.injuries",
  [NEWS_SUBJECTS.loans]: "news.loans",
  [NEWS_SUBJECTS.transfers]: "news.transfers",
  [NEWS_SUBJECTS.finance]: "news.finance",
  [NEWS_SUBJECTS.tribunal]: "news.tribunal",
  [NEWS_SUBJECTS.retirement]: "news.retirement",
  [NEWS_SUBJECTS.clubStatus]: "news.clubStatus",
};

/** Which frame a subject's body uses, re-evaluated after every merge. */
function frameFor(subject: string, entries: NewsEntry[]): MessageRef | undefined {
  if (subject === NEWS_SUBJECTS.tactics) {
    // Branch on a STABLE message key, not on English prose: the lineup frame
    // applies when every entry is a lineup confirmation, otherwise the orders
    // frame. This keys a domain decision on the key, not the rendered text.
    const lineup = entries.length > 0 && entries.every((e) => isMessageRef(e.detail) && e.detail.k === "news.detail.tacticsLineup");
    return msg(lineup ? "news.tacticsLineup" : "news.tacticsOrders");
  }
  const frame = FRAME_BY_SUBJECT[subject];
  return frame ? msg(frame) : undefined;
}

export interface PublishNewsInput {
  kind: string;
  /** Required for unsubjected text items (MOTDs, the pre-season report);
   *  ignored for key-native grouped subjects whose body is the frame key. */
  text?: string;
  /** Locale-independent body for ungrouped text items (or any item). */
  body?: MessageRef;
  headline?: string;
  clubId?: number;
  recipientClubId?: number;
  subject?: string;
  entries?: NewsEntry[];
  dayIndex?: number;
}

/**
 * Publish one news event. Same-day same-subject publishes for the same
 * audience merge into a single message; the frame body is recomputed from all
 * accumulated entries so the client always composes truthful copy.
 */
export function publishNews(world: World, input: PublishNewsInput): void {
  const hasEntries = input.entries !== undefined && input.entries.length > 0;
  const item: NewsItem = {
    dayIndex: input.dayIndex ?? world.dayIndex,
    text: input.text ?? "",
    kind: input.kind,
    ...(input.clubId !== undefined ? { clubId: input.clubId } : {}),
    ...(input.recipientClubId !== undefined ? { recipientClubId: input.recipientClubId } : {}),
    ...(input.headline !== undefined ? { headline: input.headline } : {}),
    ...(input.subject !== undefined ? { subject: input.subject, seasonId: world.mp.seasonId } : {}),
    ...(hasEntries ? { entries: dedupeEntries(input.entries!) } : {}),
  };
  if (input.body) {
    item.body = input.body;
  } else if (item.subject !== undefined) {
    const frame = frameFor(item.subject, item.entries ?? []);
    if (frame) item.body = frame;
  }
  if (item.subject === undefined) {
    world.news.push(item);
    return;
  }
  // Newest-first so repeated publishes extend today's message, not an older
  // same-subject item that survived in the history window.
  for (let i = world.news.length - 1; i >= 0; i--) {
    const candidate = world.news[i];
    if (
      candidate.kind === item.kind &&
      candidate.subject === item.subject &&
      candidate.dayIndex === item.dayIndex &&
      (candidate.seasonId ?? undefined) === (item.seasonId ?? undefined) &&
      (candidate.recipientClubId ?? undefined) === (item.recipientClubId ?? undefined) &&
      (candidate.clubId ?? undefined) === (item.clubId ?? undefined)
    ) {
      mergeInto(candidate, item);
      return;
    }
  }
  world.news.push(item);
}

function mergeInto(target: NewsItem, incoming: NewsItem): void {
  const merged = dedupeEntries([...(target.entries ?? []), ...(incoming.entries ?? [])]);
  if (merged.length > 0) target.entries = merged;
  if (incoming.headline !== undefined) target.headline = incoming.headline;
  if (target.subject !== undefined) {
    const frame = frameFor(target.subject, target.entries ?? []);
    if (frame) target.body = frame;
  }
}

function dedupeEntries(entries: NewsEntry[]): NewsEntry[] {
  const seen = new Set<string>();
  const result: NewsEntry[] = [];
  for (const entry of entries) {
    const key = entry.key ?? JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/** Dashboard visibility: own-club items and global broadcasts only. */
export function newsVisibleTo(item: Pick<NewsItem, "recipientClubId" | "clubId">, viewerClubId: number | null | undefined): boolean {
  if (item.recipientClubId !== undefined) return item.recipientClubId === viewerClubId;
  if (item.clubId !== undefined) return item.clubId === viewerClubId;
  return true;
}