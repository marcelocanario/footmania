import { describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { readNamePoolsArtifact, seedNamePoolsFromArtifact, loadNamePoolsFromDb, ensureNamePools } from "../src/services/namePoolService";
import { generateName, hasNamePool, registerNamePool } from "../src/game/names";
import { createRng } from "../src/game/rng";

const prisma = new PrismaClient();
const artifact = readNamePoolsArtifact();
const fixture = {
  countries: {
    BRA: {
      names: artifact.countries.BRA.names.slice(0, 3),
      surnames: artifact.countries.BRA.surnames.slice(0, 3),
    },
    JAP: {
      names: artifact.countries.JAP.names.slice(0, 3),
      surnames: artifact.countries.JAP.surnames.slice(0, 3),
    },
  },
};

describe("name pool artifact", () => {
  it("contains 221 countries each with names and surnames", () => {
    expect(Object.keys(artifact.countries).length).toBe(221);
    for (const [code, pools] of Object.entries(artifact.countries)) {
      expect(pools.names.length, `${code} names`).toBeGreaterThan(0);
      expect(pools.surnames.length, `${code} surnames`).toBeGreaterThan(0);
    }
  });

  it("preserves duplicate lines (they weight the deterministic RNG)", () => {
    const bra = artifact.countries.BRA;
    expect(bra.names.filter((n) => n === "Adrianinho").length).toBeGreaterThanOrEqual(2);
    expect(new Set(bra.names).size).toBeLessThan(bra.names.length);
  });
});

describe("name pool seeding", () => {
  it("seeds and re-seeds idempotently with exact row counts and ordering", async () => {
    await prisma.namePoolEntry.deleteMany();
    const first = await seedNamePoolsFromArtifact(prisma, fixture);
    expect(first.countries).toBe(2);
    expect(first.rows).toBe(12);

    const rows1 = await prisma.namePoolEntry.findMany({ orderBy: [{ countryCode: "asc" }, { kind: "asc" }, { position: "asc" }] });
    expect(rows1.length).toBe(first.rows);

    const second = await seedNamePoolsFromArtifact(prisma, fixture);
    expect(second.rows).toBe(first.rows);

    const rows2 = await prisma.namePoolEntry.findMany({ orderBy: [{ countryCode: "asc" }, { kind: "asc" }, { position: "asc" }] });
    expect(rows2.length).toBe(first.rows);
    expect(rows2.map((r) => `${r.countryCode}|${r.kind}|${r.position}|${r.value}`)).toEqual(
      rows1.map((r) => `${r.countryCode}|${r.kind}|${r.position}|${r.value}`),
    );
  });

  it("round-trips from the database into the runtime catalog with ordering intact", async () => {
    await prisma.namePoolEntry.deleteMany();
    await seedNamePoolsFromArtifact(prisma, fixture);
    await loadNamePoolsFromDb(prisma);

    expect(hasNamePool("BRA")).toBe(true);
    expect(hasNamePool("JAP")).toBe(true);

    // The first three BRA names must come back in the artifact's exact order
    // (duplicate "Adrianinho" at positions 0 and 1 included).
    const bra = fixture.countries.BRA;
    const rng = createRng(42);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const name = generateName(rng, "BRA");
      expect(name.length).toBeGreaterThan(0);
      seen.add(name);
    }
    expect(seen.size).toBeGreaterThan(1);
    const expectedFirst = new Set(bra.names.slice(0, 3));
    for (const n of Array.from(expectedFirst)) {
      expect(bra.names.includes(n), n).toBe(true);
    }
  });

  it("ensureNamePools seeds an empty table and leaves a populated one alone", async () => {
    await prisma.namePoolEntry.deleteMany();
    await ensureNamePools(prisma, fixture);
    const seeded = await prisma.namePoolEntry.count();
    expect(seeded).toBe(12);
    expect(hasNamePool("ING")).toBe(true);

    const before = await prisma.namePoolEntry.count();
    await ensureNamePools(prisma, fixture);
    const after = await prisma.namePoolEntry.count();
    expect(after).toBe(before);
  });
});

describe("name generation fallback", () => {
  it("falls back to a generic pool for unknown countries", () => {
    registerNamePool("names", "ZZZ", []);
    registerNamePool("surnames", "ZZZ", []);
    expect(hasNamePool("ZZZ")).toBe(false);
    const rng = createRng(7);
    const name = generateName(rng, "ZZZ");
    expect(name.length).toBeGreaterThan(0);
  });
});
