import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMatchGoldens } from "../tests/matchGolden";

/**
 * Regenerates tests/fixtures/match-golden.json after an INTENTIONAL change to
 * match-simulator behavior. The digests pin scores, events, stats, fatigue,
 * workload bookkeeping and the RNG state of three fixed-seed matches, so a
 * regenerated baseline must always be reviewed as carefully as source code.
 */
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "match-golden.json");
mkdirSync(dirname(fixturePath), { recursive: true });
writeFileSync(fixturePath, `${JSON.stringify(computeMatchGoldens(), null, 2)}\n`, "utf8");
console.log(`match golden written: ${fixturePath}`);
