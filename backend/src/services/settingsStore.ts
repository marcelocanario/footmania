import type { PrismaClient } from "@prisma/client";

/**
 * Generic access to the `Setting` key/value store.
 *
 * The store holds operational state that genuinely belongs in the database:
 * the global lock, scheduler bookkeeping, match timing, inactivity thresholds
 * and the join threshold. Balance parameters do NOT live here — the season
 * budget curve and the player-value model are owned by `game.config.jsonc`
 * alone, so a configuration rollout cannot be silently overridden by a stale
 * row.
 */

/** Read a numeric setting, falling back when the row is absent or unparsable. */
export async function readNumberSetting(prisma: PrismaClient, key: string, fallback: number): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const n = row?.value === undefined ? Number.NaN : Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}
