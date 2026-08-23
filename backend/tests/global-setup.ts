import { PrismaClient } from "@prisma/client";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readNamePoolsArtifact, seedNamePoolsFromArtifact, loadNamePoolsFromDb } from "../src/services/namePoolService";

/**
 * Test database bootstrap.
 *
 * Each test file that talks to Prisma points at its own persistent SQLite file
 * (test.db / test-live.db / test-persist.db / test-worker.db /
 * test-scheduler.db), created once via
 * `prisma db push` and kept in sync with the schema (see AGENTS.md). This setup
 * clears every row in all five databases before the suite runs so tests that
 * register users / create worlds start from a clean state.
 *
 * Rows are deleted in dependency order (children before parents) using the
 * generated client with an explicit datasource URL. This avoids spawning
 * `prisma db push` and avoids deleting the DB files, both of which are
 * unreliable on Windows (deadlocks / transient lock / EPERM errors).
 *
 * The name-pool reference data (NamePoolEntry) is seeded from the committed
 * artifact after cleanup so world generation can draw from the database.
 */
export default async function setup(): Promise<void> {
  const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");
  const artifact = readNamePoolsArtifact();
  // Integration tests need real country pools, not the full production-sized
  // artifact. Keep a few ordered entries per country so generation and fallback
  // behavior remain representative without inserting tens of thousands of rows.
  const testArtifact = {
    countries: Object.fromEntries(
      Object.entries(artifact.countries).map(([code, pools]) => [code, {
        names: pools.names.slice(0, 3),
        surnames: pools.surnames.slice(0, 3),
      }]),
    ),
  };
  for (const name of ["test.db", "test-live.db", "test-persist.db", "test-worker.db", "test-scheduler.db", "test-season-archive.db", "test-team-profile.db"]) {
    const url = `file:${join(cwd, "prisma", name).replaceAll("\\", "/")}`;
    const prisma = new PrismaClient({ datasourceUrl: url, log: [] });
    try {
      // Sequential deleteMany avoids SQLite write-lock contention inside a
      // single large transaction. Children are deleted before parents.
      await prisma.matchEvent.deleteMany();
      await prisma.matchStat.deleteMany();
      await prisma.match.deleteMany();
      await prisma.standingsRow.deleteMany();
      await prisma.fixture.deleteMany();
      await prisma.competition.deleteMany();
      await prisma.ledgerEntry.deleteMany();
      await prisma.newsItem.deleteMany();
      // Pro/moderation tables are global (user-scoped) but sport-linked tables must be cleared first.
      await prisma.playerSeasonHistory.deleteMany().catch(() => {});
      await prisma.userNotification.deleteMany().catch(() => {});
      await prisma.pushSubscription.deleteMany().catch(() => {});
      await prisma.warning.deleteMany().catch(() => {});
      await prisma.player.deleteMany();
      await prisma.club.deleteMany();
      await prisma.loan.deleteMany();
      await prisma.trophy.deleteMany();
      await prisma.seasonAward.deleteMany();
      await prisma.careerRecord.deleteMany();
      await prisma.liveMatch.deleteMany();
      await prisma.marketBid.deleteMany();
      await prisma.transferAuction.deleteMany();
      await prisma.freeAgentListing.deleteMany();
      await prisma.marketReservation.deleteMany();
      await prisma.playerMarketTransaction.deleteMany();
      await prisma.mpMembership.deleteMany();
      await prisma.mpClubSeason.deleteMany();
      await prisma.mpQueue.deleteMany();
      await prisma.mpAllocation.deleteMany();
      await prisma.mpActivity.deleteMany();
       await prisma.mpAudit.deleteMany();
       await prisma.mpSeason.deleteMany();
       await prisma.invitation.deleteMany();
       await prisma.friendship.deleteMany();
       await prisma.session.deleteMany();
      await prisma.setting.deleteMany();
      await prisma.dailyExecution.deleteMany();
      await prisma.save.deleteMany();
      await prisma.user.deleteMany();
      // Name-pool reference data is not save-scoped: wipe and reseed the compact
      // integration fixture so tests are isolated without a 50k-row import.
      await prisma.namePoolEntry.deleteMany();
      await seedNamePoolsFromArtifact(prisma, testArtifact);
    } finally {
      await prisma.$disconnect();
    }
  }
  // The in-memory catalog is process-global: load once (from the last DB) so
  // pure engine tests that never touch Prisma still get country pools.
  const prisma = new PrismaClient({ datasourceUrl: `file:${join(cwd, "prisma", "test.db").replaceAll("\\", "/")}`, log: [] });
  try {
    await loadNamePoolsFromDb(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
