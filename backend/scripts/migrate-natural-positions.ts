import { PrismaClient } from "@prisma/client";
import { withGlobalLock, withGlobalLease } from "../src/services/lock";
import { buildMigrationPlan, type MigrationPlayer } from "../src/services/naturalPositionMigration";
import { positionToCode } from "../src/game/positions";

/**
 * V1 -> V2 natural-position migration (§14). Thin Prisma wrapper: all decision
 * logic lives in `src/services/naturalPositionMigration.ts` so it is unit
 * tested without a database.
 *
 * Reads migration-specific row projections and parses savedLineupJson directly —
 * it never calls loadWorld/hydration while the Save is version 1 (codes 1/3/4
 * still mean legacy FB/MF/FW until the transaction commits v2).
 *
 * Idempotent: a second run on an already-v2 Save performs no database write,
 * including no lease write.
 */

const prisma = new PrismaClient();

async function run(): Promise<void> {
  await withGlobalLock(async () => {
    const save = await prisma.save.findFirst({
      where: { isGlobal: true },
      select: { id: true, revision: true, positionModelVersion: true, seed: true },
    });
    if (!save) {
      console.log("[position-migration] no global Save; nothing to do");
      return;
    }
    if (save.positionModelVersion >= 2) {
      console.log(`[position-migration] Save ${save.id} already at position-model v${save.positionModelVersion}; no-op`);
      return;
    }
    if (save.positionModelVersion !== 1) {
      throw new Error(`[position-migration] unknown positionModelVersion ${save.positionModelVersion}`);
    }
    await withGlobalLease(prisma, async () => {
      // §14.1 step 3: reread and revalidate the Save after acquiring the lease.
      const current = await prisma.save.findFirstOrThrow({
        where: { isGlobal: true },
        select: { id: true, revision: true, positionModelVersion: true, seed: true },
      });
      if (current.positionModelVersion !== 1) {
        console.log(`[position-migration] Save moved to v${current.positionModelVersion} while waiting for the lease; no-op`);
        return;
      }
      // §14.1 step 4: refuse migration with live matches.
      const liveCount = await prisma.liveMatch.count({ where: { saveId: current.id } });
      if (liveCount > 0) {
        throw new Error("[position-migration] a LiveMatch row exists; run between live matches");
      }

      const rows = await prisma.player.findMany({
        where: { saveId: current.id },
        select: {
          id: true, clubId: true, isYouth: true, position: true, overall: true,
          injuryDays: true, suspendedGames: true, onSale: true,
          skillGol: true, skillPace: true, skillTec: true, skillPas: true,
          skillDes: true, skillPlaymaking: true, skillFin: true,
        },
      });
      // The Prisma column rename has already happened, so skillPace/skillPlaymaking
      // hold the legacy vel/arm values; only `position` is still V1-encoded.
      const players: MigrationPlayer[] = rows.map((r) => ({
        id: r.id,
        clubId: r.clubId,
        isYouth: r.isYouth,
        legacy: r.position as MigrationPlayer["legacy"],
        overall: r.overall,
        injuryDays: r.injuryDays,
        suspendedGames: r.suspendedGames,
        onSale: r.onSale,
        skills: {
          gol: r.skillGol, pace: r.skillPace, tec: r.skillTec, pas: r.skillPas,
          des: r.skillDes, playmaking: r.skillPlaymaking, fin: r.skillFin,
        },
      }));
      const loans = await prisma.loan.findMany({
        where: { saveId: current.id },
        select: { playerId: true, fromClubId: true },
      });
      const clubs = await prisma.club.findMany({
        where: { saveId: current.id },
        select: { id: true, savedLineupJson: true, tacticsFormation: true, penaltyTakerId: true },
      });

      // Everything below the plan is mechanical: the plan itself validates the
      // legacy codes and proves numeric neutrality, throwing before any write.
      const plan = buildMigrationPlan(players, clubs, current.seed, new Map(loans.map((l) => [l.playerId, l.fromClubId])));
      const rewritten = plan.lineupUpdates.filter((u) => u.json !== null).length;
      const dropped = plan.lineupUpdates.length - rewritten;

      // §14.1 step 6: one transaction for player positions, lineup rewrites,
      // version bump and revision increment; finish with the optimistic CAS.
      const capturedRevision = current.revision;
      await prisma.$transaction(async (tx) => {
        const byCode = new Map<number, number[]>();
        for (const p of players) {
          const code = positionToCode(plan.positionByPlayer.get(p.id)!);
          const list = byCode.get(code) ?? [];
          list.push(p.id);
          byCode.set(code, list);
        }
        for (const [code, ids] of byCode) {
          await tx.player.updateMany({ where: { saveId: current.id, id: { in: ids } }, data: { position: code } });
        }
        // Group identical payloads so a large world is a handful of statements.
        const byPayload = new Map<string, number[]>();
        for (const update of plan.lineupUpdates) {
          const key = `${update.json ?? ""} ${update.penaltyTakerId ?? ""}`;
          const list = byPayload.get(key) ?? [];
          list.push(update.clubId);
          byPayload.set(key, list);
        }
        for (const clubIds of byPayload.values()) {
          const sample = plan.lineupUpdates.find((u) => u.clubId === clubIds[0])!;
          await tx.club.updateMany({
            where: { saveId: current.id, id: { in: clubIds } },
            data: { savedLineupJson: sample.json, penaltyTakerId: sample.penaltyTakerId },
          });
        }
        // §14.1 step 7: optimistic CAS.
        const cas = await tx.save.updateMany({
          where: { id: current.id, positionModelVersion: 1, revision: capturedRevision },
          data: { positionModelVersion: 2, revision: capturedRevision + 1 },
        });
        if (cas.count !== 1) {
          throw new Error("[position-migration] optimistic concurrency check failed; another writer moved the Save");
        }
      });

      const roleReport = Object.entries(plan.countsByRole)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([role, n]) => `${role}=${n}`)
        .join(" ");
      console.log(
        `[position-migration] migrated Save ${current.id}: ${players.length} players (${roleReport}), ` +
        `${rewritten} lineups rewritten, ${dropped} dropped for sanitation, ` +
        `revision ${capturedRevision} -> ${capturedRevision + 1}, version 2`,
      );
      // §14.1 step 8: the process exits after this script, so the next server
      // start loads a fresh world — there is no in-process cache to invalidate.
    });
  });
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
