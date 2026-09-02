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

// Runtime configuration is loaded relative to the compiled `dist/src` files,
// so the JSONC files must be present beside the compiled output as well.
const configSource = join(root, "config");
const configTarget = join(root, "dist", "config");
if (!existsSync(configSource)) {
  console.error(`copy-game-data: missing config directory ${configSource}`);
  process.exit(1);
}
mkdirSync(configTarget, { recursive: true });
cpSync(configSource, configTarget, { recursive: true });
console.log(`copy-game-data: ${configSource} -> ${configTarget}`);

const assetsSource = join(root, "assets");
const assetsTarget = join(root, "dist", "assets");
if (!existsSync(assetsSource)) {
  console.error(`copy-game-data: missing assets directory ${assetsSource}`);
  process.exit(1);
}
mkdirSync(assetsTarget, { recursive: true });
cpSync(assetsSource, assetsTarget, { recursive: true });
console.log(`copy-game-data: ${assetsSource} -> ${assetsTarget}`);
