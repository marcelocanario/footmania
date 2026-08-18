import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export default function setup() {
  const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd,
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "ignore",
  });
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd,
    env: { ...process.env, DATABASE_URL: "file:./test-live.db" },
    stdio: "ignore",
  });
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd,
    env: { ...process.env, DATABASE_URL: "file:./test-persist.db" },
    stdio: "ignore",
  });
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd,
    env: { ...process.env, DATABASE_URL: "file:./test-worker.db" },
    stdio: "ignore",
  });
}