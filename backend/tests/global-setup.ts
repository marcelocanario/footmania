import { resetTestDb } from "./resetTestDb";

/**
 * Runs once before the whole integration run starts, so the shared Postgres
 * `test` schema (see testDbUrl.ts) is clean even before the first file's own
 * per-file reset (tests/setup.ts) runs.
 */
export default async function setup(): Promise<void> {
  await resetTestDb();
}
