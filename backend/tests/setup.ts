import { registerNamePool } from "../src/game/names";
import { readNamePoolsArtifact } from "../src/services/namePoolService";

// Populate the in-memory name catalog from the committed artifact so pure
// engine tests (generateWorld without a database) generate real country names.
// setupFiles run in the same worker as the test files, unlike globalSetup.
const artifact = readNamePoolsArtifact();
for (const [code, pools] of Object.entries(artifact.countries)) {
  registerNamePool("names", code, pools.names);
  registerNamePool("surnames", code, pools.surnames);
}
