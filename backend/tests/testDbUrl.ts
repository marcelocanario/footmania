import "dotenv/config";

// All integration suites share this one Postgres schema (kept separate from
// "development") rather than each getting its own database. Serialized
// execution (see vitest.integration.config.ts) still applies since suites
// share state through the same schema.
export const TEST_DATABASE_URL = (() => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see backend/.env.example)");

  // resetTestDb intentionally truncates every application table. Refuse the
  // two production-shaped targets that are easiest to paste here by mistake,
  // and require an explicit isolated schema for every integration run.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL with schema=test");
  }
  const username = decodeURIComponent(parsed.username).toLowerCase();
  const schema = parsed.searchParams.get("schema")?.toLowerCase();
  if (username === "footmania_prod" || schema !== "test") {
    throw new Error("Refusing integration tests: TEST_DATABASE_URL must use a non-production user and schema=test");
  }
  return url;
})();
