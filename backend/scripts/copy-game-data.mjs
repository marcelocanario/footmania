import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * tsc emits only compiled JS/declarations — runtime-read data assets are not
 * copied to dist. `energyInjury.ts` loads its versioned model JSON via
 * readFileSync at module init, so a missing copy would crash the production
 * server at startup (tests/dev run straight from src/ and never hit this).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "game", "data");
// rootDir is the backend folder, so src/** is emitted under dist/src/**.
const target = join(root, "dist", "src", "game", "data");
if (!existsSync(source)) {
  console.error(`copy-game-data: missing source directory ${source}`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`copy-game-data: ${source} -> ${target}`);
