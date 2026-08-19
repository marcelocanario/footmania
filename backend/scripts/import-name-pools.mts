#!/usr/bin/env node
/**
 * Imports the committed name-pools artifact into the NamePoolEntry table.
 *
 * Run: npm run db:seed-name-pools  (from backend/)
 *
 * Idempotent by design: the table is wiped and rebuilt to exactly match
 * backend/assets/namepools.json, so pool order and duplicate lines are
 * preserved and re-running is always safe.
 */
import { PrismaClient } from "@prisma/client";
import { seedNamePoolsFromArtifact } from "../src/services/namePoolService";

const prisma = new PrismaClient();

async function main() {
  const { rows, countries } = await seedNamePoolsFromArtifact(prisma);
  console.log(`Seeded NamePoolEntry: ${rows} rows across ${countries} countries`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
