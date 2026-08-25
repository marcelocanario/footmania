import { beforeAll } from "vitest";
import { resetTestDb } from "./resetTestDb";

// Runs once per test FILE (each integration suite is its own forked process,
// see vitest.integration.config.ts). All suites share one Postgres schema, so
// each file must re-clean it before its own tests run — otherwise data left
// behind by whichever file ran before it (unique usernames, club ids, etc.)
// can collide with this file's fixtures.
beforeAll(async () => {
  await resetTestDb();
});
