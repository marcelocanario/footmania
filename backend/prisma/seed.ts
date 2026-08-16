import { PrismaClient } from "@prisma/client";
import { generateWorld } from "../src/game/worldgen";
import { createSaveRecord, loadWorld, persistWorld } from "../src/services/saveService";

const prisma = new PrismaClient();

async function main() {
  const world = generateWorld(20260815);
  console.log(
    `Generated world: ${world.clubs.length} clubs, ${world.players.length} players, ${world.competitions.length} competitions, ${world.fixtures.length} fixtures`
  );

  let user = await prisma.user.findUnique({ where: { username: "demo" } });
  if (!user) {
    user = await prisma.user.create({
      data: { username: "demo", passwordHash: "$2b$10$not.real.password.hash.placeholder.0000000000000000000000000" },
    });
    console.log("Created demo user");
  }
  const save = await createSaveRecord(prisma, user.id, "Demo Career", world.seed);
  console.log(`Created save #${save.id} with ${save.clubOptions.length} division-1 club options`);

  const loaded = await loadWorld(prisma, save.id, user.id);
  console.log(loaded ? `Round-trip load OK: ${loaded.world.clubs.length} clubs` : "Round-trip load FAILED");

  world.year = 3;
  await persistWorld(prisma, save.id, user.id, world);
  console.log("persistWorld OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
