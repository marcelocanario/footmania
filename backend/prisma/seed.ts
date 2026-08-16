import { generateWorld } from "../src/game/worldgen";
import { serializeWorld } from "../src/services/saveService";

const world = generateWorld(20260815);
console.log(
  `Generated world: ${world.clubs.length} clubs, ${world.players.length} players, ${world.competitions.length} competitions, ${world.fixtures.length} fixtures`
);
console.log(serializeWorld(world).length, "bytes serialized");
