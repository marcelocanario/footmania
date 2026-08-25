import type { Prisma, PrismaClient } from "@prisma/client";
import { registerNamePool } from "../game/names";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type Tx = Prisma.TransactionClient;

/**
 * Name-pool reference data management.
 *
 * The committed seed artifact (backend/assets/namepools.json) is the source of
 * truth for the NamePoolEntry rows. `seedNamePoolsFromArtifact` is a full
 * wipe-and-reload so an import is idempotent by construction: the table ends up
 * exactly matching the artifact no matter how many times it runs, and pool
 * order / duplicate lines are preserved (they weight the deterministic RNG).
 */
const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = join(here, "..", "..", "assets", "namepools.json");

export interface NamePoolsArtifact {
  countries: Record<string, { names: string[]; surnames: string[] }>;
}

export function readNamePoolsArtifact(path: string = ARTIFACT_PATH): NamePoolsArtifact {
  const raw = JSON.parse(readFileSync(path, "utf8")) as NamePoolsArtifact;
  if (!raw.countries || typeof raw.countries !== "object") {
    throw new Error("Invalid name-pools artifact: missing countries map");
  }
  for (const [code, pools] of Object.entries(raw.countries)) {
    if (!Array.isArray(pools.names) || !Array.isArray(pools.surnames)) {
      throw new Error(`Invalid name-pools artifact: ${code} missing names/surnames arrays`);
    }
  }
  return raw;
}

/** Load the whole artifact into the NamePoolEntry table (wipe + reload). */
export async function seedNamePoolsFromArtifact(
  prisma: PrismaClient | Tx,
  artifact: NamePoolsArtifact = readNamePoolsArtifact(),
): Promise<{ rows: number; countries: number }> {
  await prisma.namePoolEntry.deleteMany();
  let rows = 0;
  let countries = 0;
  const allEntries: { countryCode: string; kind: string; position: number; value: string }[] = [];
  for (const [code, pools] of Object.entries(artifact.countries)) {
    const entries: { countryCode: string; kind: string; position: number; value: string }[] = [];
    let pos = 0;
    for (const value of pools.names) {
      entries.push({ countryCode: code, kind: "names", position: pos++, value });
    }
    pos = 0;
    for (const value of pools.surnames) {
      entries.push({ countryCode: code, kind: "surnames", position: pos++, value });
    }
    if (entries.length === 0) continue;
    countries++;
    rows += entries.length;
    allEntries.push(...entries);
  }
  // Batch inserts to stay well under Postgres's per-statement bind-parameter
  // limit. skipDuplicates keeps concurrent/reset re-seeding idempotent (a
  // stale row from another schema or a partial truncate must not crash).
  for (let offset = 0; offset < allEntries.length; offset += 2000) {
    await prisma.namePoolEntry.createMany({ data: allEntries.slice(offset, offset + 2000), skipDuplicates: true });
  }
  return { rows, countries };
}

/** Load every row into the in-memory name catalog used by generateName. */
export async function loadNamePoolsFromDb(prisma: PrismaClient | Tx): Promise<number> {
  const rows = await prisma.namePoolEntry.findMany({ orderBy: [{ countryCode: "asc" }, { kind: "asc" }, { position: "asc" }] });
  let countries = 0;
  const byCountry: Record<string, { names: string[]; surnames: string[] }> = {};
  for (const row of rows) {
    byCountry[row.countryCode] ??= { names: [], surnames: [] };
    byCountry[row.countryCode][row.kind === "surnames" ? "surnames" : "names"].push(row.value);
  }
  for (const [code, pools] of Object.entries(byCountry)) {
    registerNamePool("names", code, pools.names);
    registerNamePool("surnames", code, pools.surnames);
    countries++;
  }
  return countries;
}

/**
 * Ensure the in-memory name catalog is populated. Seed the database from the
 * committed artifact on first run (idempotent), then load into memory.
 */
export async function ensureNamePools(prisma: PrismaClient, artifact: NamePoolsArtifact = readNamePoolsArtifact()): Promise<void> {
  const existing = await prisma.namePoolEntry.count();
  if (existing === 0) {
    await seedNamePoolsFromArtifact(prisma, artifact);
  }
  await loadNamePoolsFromDb(prisma);
}
