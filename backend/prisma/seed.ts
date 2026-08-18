import { PrismaClient } from "@prisma/client";
import { generateWorld } from "../src/game/worldgen";
import { ensureGlobalSave, loadGlobalWorld, persistWorld } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { initSeason } from "../src/game/multiplayer";
import { seasonRefFor } from "../src/game/clock";

const prisma = new PrismaClient();

async function main() {
  const save = await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("Global save could not be loaded");

  const world = generateWorld(20260815);
  const ref = seasonRefFor(new Date());
  const season = await ensureSeasonRow(prisma, ref);
  initSeason(world, ref, season.seasonId);

  console.log(
    `Generated world: ${world.clubs.length} clubs, ${world.players.length} players, ${world.competitions.length} competitions, ${world.fixtures.length} fixtures`,
  );
  await persistWorld(prisma, save.id, save.id, world, loaded.save.revision);
  console.log(`Global save #${save.id} seeded for ${ref.year}-${String(ref.month).padStart(2, "0")}`);

  const roundTrip = await loadGlobalWorld(prisma);
  console.log(roundTrip ? `Round-trip load OK: ${roundTrip.world.clubs.length} clubs` : "Round-trip load FAILED");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
