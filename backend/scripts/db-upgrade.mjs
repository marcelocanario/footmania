import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: backendRoot,
    stdio: "inherit",
    // Windows exposes npx as a .cmd shim, which needs a shell for spawnSync.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Migrations run only against the DATABASE_URL supplied by the deployment
// environment. CI points that variable at its disposable PostgreSQL service;
// production uses the separate footmania_prod account and production schema.
run(npx, ["--no-install", "prisma", "migrate", "deploy"]);

// The custom data migrations are compiled into dist for the production image.
// Run them through tsx because TypeScript's bundler output intentionally keeps
// extensionless internal imports, which plain Node ESM cannot resolve.
// The source fallback keeps the same command useful during local development.
const compiledScripts = join(backendRoot, "dist", "scripts");
const migrationScripts = ["migrate-natural-positions", "migrate-contract-market"];
for (const name of migrationScripts) {
  const compiled = join(compiledScripts, `${name}.js`);
  if (existsSync(compiled)) {
    run(npx, ["--no-install", "tsx", compiled]);
  } else {
    run(npx, ["--no-install", "tsx", `scripts/${name}.ts`]);
  }
}
