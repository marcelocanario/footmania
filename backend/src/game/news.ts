import type { NewsEntry, NewsItem, World } from "./types";

/**
 * Central dashboard news service.
 *
 * All player-facing news is published through `publishNews`. Items carrying a
 * `subject` are grouped: publishing on the same season day, for the same
 * audience and subject, merges into the existing message instead of creating
 * a new feed row (contract expiries, academy moves, injuries…). Items without
 * a subject never merge — MOTDs, one-off reports and legacy rows.
 *
 * Visibility rule: `recipientClubId` restricts visibility to that club's
 * manager. Public items with a `clubId` are shown only to that club; items
 * without either attribution are global broadcasts.
 *
 * Grouping is a domain invariant and therefore lives here, not in config; no
 * balance tunables exist in this module. Body copy for grouped subjects is
 * regenerated from the accumulated entries so counts stay truthful after
 * merges, deterministically — gameplay RNG is never consumed here.
 */

/** Compact currency formatter shared by every news text builder. */
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

export interface PublishNewsInput {
  kind: string;
  /** Required for unsubjected items; ignored for grouped subjects whose body
   *  is rendered from the accumulated entries. */
  text?: string;
  headline?: string;
  clubId?: number;
  recipientClubId?: number;
  subject?: string;
  entries?: NewsEntry[];
  dayIndex?: number;
}

/**
 * Publish one news event. Same-day same-subject publishes for the same
 * audience merge into a single message; the body is re-rendered from all
 * accumulated entries so prose always matches the facts.
 */
export function publishNews(world: World, input: PublishNewsInput): void {
  const item: NewsItem = {
    dayIndex: input.dayIndex ?? world.dayIndex,
    text: input.text ?? "",
    kind: input.kind,
    ...(input.clubId !== undefined ? { clubId: input.clubId } : {}),
    ...(input.recipientClubId !== undefined ? { recipientClubId: input.recipientClubId } : {}),
    ...(input.headline !== undefined ? { headline: input.headline } : {}),
    ...(input.subject !== undefined ? { subject: input.subject, seasonId: world.mp.seasonId } : {}),
    ...(input.entries !== undefined && input.entries.length > 0 ? { entries: dedupeEntries(input.entries) } : {}),
  };
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
  renderGroupedBody(item);
  world.news.push(item);
}

function mergeInto(target: NewsItem, incoming: NewsItem): void {
  const merged = dedupeEntries([...(target.entries ?? []), ...(incoming.entries ?? [])]);
  if (merged.length > 0) target.entries = merged;
  if (incoming.headline !== undefined) target.headline = incoming.headline;
  renderGroupedBody(target);
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

function renderGroupedBody(item: NewsItem): void {
  const renderer = SUBJECT_RENDERERS[item.subject ?? ""];
  if (!renderer) return;
  item.text = renderer(item.entries ?? []);
}

type SubjectRenderer = (entries: NewsEntry[]) => string;

function listFacts(entries: NewsEntry[]): string {
  const seen = new Set<string>();
  const facts = entries
    .filter((entry) => {
      const key = `${entry.label ?? ""}\u0000${entry.detail ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((entry) => ({ label: entry.label ?? entry.detail ?? "", detail: entry.detail }))
    .filter((entry) => entry.label);
  const details = [...new Set(facts.map((entry) => entry.detail).filter(Boolean))];
  if (details.length === 1) return formatList(facts.map((entry) => entry.label));
  const rendered = facts.map((entry) => entry.detail ? `${entry.label} (${entry.detail})` : entry.label);
  return formatList(rendered);
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/**
 * Per-subject body copy. The text is deliberately complete: the dashboard
 * renders one natural-language message, while entries remain persisted for
 * deterministic merging and auditability.
 */
const SUBJECT_RENDERERS: Record<string, SubjectRenderer> = {
  [NEWS_SUBJECTS.contractWarning]: (entries) =>
    `Player contracts expiring soon: ${listFacts(entries)}. These deals have entered their renewal window, and the clock is running down before the players reach the open market.`,
  [NEWS_SUBJECTS.contractExpiry]: (entries) =>
    `Contract departures: ${listFacts(entries)}. The players have left as free agents, and the open market is now their next destination.`,
  [NEWS_SUBJECTS.contractRenewal]: (entries) =>
    `New deals signed: ${listFacts(entries)}. The paperwork is complete and the squad's future is secured for the agreed term.`,
  [NEWS_SUBJECTS.academy]: (entries) =>
    `Academy report: ${listFacts(entries)}. Another chapter has been written in the club's youth pathway.`,
  [NEWS_SUBJECTS.injuries]: (entries) =>
    `Medical report: ${listFacts(entries)}. The treatment room has the latest recovery timetable, and the coaching staff must plan around it.`,
  [NEWS_SUBJECTS.loans]: (entries) =>
    `Loan update: ${listFacts(entries)}. The club can now decide what role comes next.`,
  [NEWS_SUBJECTS.transfers]: (entries) =>
    `Transfer desk: ${listFacts(entries)}. The deal is complete and the market ledger has been updated.`,
  [NEWS_SUBJECTS.finance]: (entries) =>
    `The board has stepped in: ${listFacts(entries)}. The financial pressure is now part of the manager's matchday reality.`,
  [NEWS_SUBJECTS.tribunal]: (entries) =>
    `Disciplinary verdict: ${listFacts(entries)}. The suspension must now be accounted for in the next team selection.`,
  [NEWS_SUBJECTS.retirement]: (entries) =>
    `Farewell on the horizon: ${listFacts(entries)}. One final campaign now lies between these veterans and the end of their playing days.`,
  [NEWS_SUBJECTS.tactics]: (entries) => entries.every((entry) => entry.detail === "confirmed the lineup")
    ? `Matchday call: ${listFacts(entries)}. The starting lineup is set, and the team now has its orders for the opening whistle.`
    : `Tactical room: ${listFacts(entries)}. The new instructions will shape the team's next passage of play.`,
  [NEWS_SUBJECTS.clubStatus]: (entries) =>
    `Club bulletin: ${listFacts(entries)}. The club's place in the pyramid has changed, and the campaign moves on.`,
};

/** Dashboard visibility: own-club items and global broadcasts only. */
export function newsVisibleTo(item: Pick<NewsItem, "recipientClubId" | "clubId">, viewerClubId: number | null | undefined): boolean {
  if (item.recipientClubId !== undefined) return item.recipientClubId === viewerClubId;
  if (item.clubId !== undefined) return item.clubId === viewerClubId;
  return true;
}
