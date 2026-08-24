import type { SeasonAward, SeasonAwardEntry } from "../api/client";

/**
 * Best XI members of a best_xi award. Prefers the server-resolved `entries`
 * (ids + active flags); falls back to parsing legacy detail rows (bare name
 * arrays) so old awards keep rendering as non-clickable names.
 */
export function bestXiEntries(award: SeasonAward): SeasonAwardEntry[] | null {
  if (award.category !== "best_xi") return null;
  if (award.entries && award.entries.length > 0) return award.entries;
  if (!award.detail) return null;
  try {
    const parsed = JSON.parse(award.detail) as unknown;
    if (!Array.isArray(parsed)) return null;
    const entries = parsed
      .map((entry): SeasonAwardEntry | null => {
        if (typeof entry === "string") return { id: null, clubId: null, name: entry, active: false };
        const e = entry as { id?: unknown; name?: unknown; clubId?: unknown };
        if (typeof e.id === "number" && typeof e.name === "string") {
          return { id: e.id, clubId: typeof e.clubId === "number" ? e.clubId : null, name: e.name, active: false };
        }
        return null;
      })
      .filter((entry): entry is SeasonAwardEntry => entry !== null);
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/** Human-readable detail line for an individual (non-Best-XI) award. */
export function individualAwardDetail(award: SeasonAward): string {
  return award.detail ?? "";
}
