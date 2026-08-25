import { PrismaClient } from "@prisma/client";
import { readNamePoolsArtifact, seedNamePoolsFromArtifact, loadNamePoolsFromDb } from "../src/services/namePoolService";
import { TEST_DATABASE_URL } from "./testDbUrl";

// Integration tests need real country pools, not the full production-sized
// artifact. Keep a few ordered entries per country so generation and fallback
// behavior remain representative without inserting tens of thousands of rows.
function buildTestArtifact() {
  const artifact = readNamePoolsArtifact();
  return {
    countries: Object.fromEntries(
      Object.entries(artifact.countries).map(([code, pools]) => [code, {
        names: pools.names.slice(0, 3),
        surnames: pools.surnames.slice(0, 3),
      }]),
    ),
  };
}

/**
 * Truncates every table in the shared Postgres `test` schema and reseeds the
 * compact name-pool fixture. All integration suites share this one schema
 * (see testDbUrl.ts), so this must run before EACH test file's tests, not
 * just once for the whole run, otherwise data created by one file (users,
 * clubs, unique constraints) leaks into and collides with the next file.
 */
export async function resetTestDb(): Promise<void> {
  const testArtifact = buildTestArtifact();
  const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL, log: [] });
  try {
    // A single TRUNCATE ... CASCADE is far faster than ~35 sequential
    // deleteMany calls and resets identity sequences to boot. The query runs
    // against the schema-agnostic Prisma connection; TRUNCATE is applied to
    // the tables in the current search_path, which the TEST_DATABASE_URL pins
    // to the shared `test` schema.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Save", "User", "Session", "Friendship", "Invitation", "Club", "Player", "Loan", "Competition", "StandingsRow", "Fixture", "Match", "MatchStat", "MatchEvent", "NewsItem", "LedgerEntry", "Trophy", "SeasonAward", "CareerRecord", "LiveMatch", "TransferAuction", "MarketBid", "FreeAgentListing", "MarketReservation", "PlayerMarketTransaction", "MpSeason", "MpMembership", "MpClubSeason", "MpQueue", "MpAllocation", "MpActivity", "MpAudit", "Setting", "DailyExecution", "PlayerSeasonHistory", "Warning", "UserNotification", "PushSubscription", "AdminSchedulerAudit", "GameClock", "NamePoolEntry" RESTART IDENTITY CASCADE',
    );
    // The in-memory catalog is process-global: load once per file so pure
    // engine tests that never touch Prisma still get country pools.
    await seedNamePoolsFromArtifact(prisma, testArtifact);
    await loadNamePoolsFromDb(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
