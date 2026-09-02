import type { PrismaClient } from "@prisma/client";
import { parseStoredPresets } from "../game/automation";
import type { AutomationPreset } from "../game/types";

/**
 * Automation presets are club-scoped configuration, not simulation state:
 * they are stored in `Club.automationPresetsJson` (a plain column) but are
 * deliberately kept OUT of the in-memory `World`/`Club` object entirely
 * (plan §11 Part 4). Reasons:
 *
 * - Every world load used to parse and hold every club's presets in memory,
 *   even though only the handful of clubs in a live match ever need them.
 * - `persistWorld`/`clubRow` rewrite the WHOLE club row whenever anything
 *   about that club changed; a preset field merely left `undefined` on a
 *   lazily-loaded Club would be overwritten to null by the next unrelated
 *   club update (cash, activity timestamp, ...), silently destroying it.
 *   Removing the field from the `Club` type and from `clubRow` eliminates
 *   that failure mode structurally.
 *
 * Because presets live outside `Save.revision`'s optimistic-concurrency
 * transaction, a concurrent preset edit and a concurrent world mutation never
 * conflict with each other — worst case a rule edit lands a moment later.
 * This is intentional (see INVARIANTS.md); do not "fix" it back into the
 * world load/mutate/persist cycle.
 */

type ClubPresetRow = { id: number; automationPresetsJson: string | null; tacticsFormation: number };

/** Trust no persisted JSON (mirrors services/saveService.ts's jsonOr). */
function jsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Load presets for a specific set of clubs (e.g. the two sides of the live
 *  matches currently being advanced). Clubs with no stored presets, or a
 *  corrupt/unparseable payload, map to an empty array — never omitted, so
 *  `.get(id) ?? []` is never required by callers but is still safe. */
export async function loadPresetsForClubs(prisma: PrismaClient, saveId: number, clubIds: number[]): Promise<Map<number, AutomationPreset[]>> {
  const result = new Map<number, AutomationPreset[]>();
  if (clubIds.length === 0) return result;
  const rows: ClubPresetRow[] = await prisma.club.findMany({
    where: { saveId, id: { in: clubIds } },
    select: { id: true, automationPresetsJson: true, tacticsFormation: true },
  });
  for (const row of rows) {
    result.set(row.id, parseStoredPresets(jsonOr<unknown>(row.automationPresetsJson, null), row.tacticsFormation) ?? []);
  }
  return result;
}

/** Convenience single-club read (GET /mp/automation). */
export async function loadPresetsForClub(prisma: PrismaClient, saveId: number, clubId: number): Promise<AutomationPreset[]> {
  const map = await loadPresetsForClubs(prisma, saveId, [clubId]);
  return map.get(clubId) ?? [];
}

/** Overwrite one club's stored presets. Callers are responsible for schema
 *  validation, quota checks and payload-size limits before calling this — see
 *  routes/proFeatures.ts. */
export async function savePresetsForClub(prisma: PrismaClient, saveId: number, clubId: number, presets: AutomationPreset[]): Promise<void> {
  await prisma.club.update({
    where: { saveId_id: { saveId, id: clubId } },
    data: { automationPresetsJson: presets.length > 0 ? JSON.stringify(presets) : null },
  });
}

/** Wipe one club's stored presets (account deletion / AI takeover, §38). */
export async function clearPresetsForClub(prisma: PrismaClient, saveId: number, clubId: number): Promise<void> {
  await prisma.club.update({ where: { saveId_id: { saveId, id: clubId } }, data: { automationPresetsJson: null } });
}
