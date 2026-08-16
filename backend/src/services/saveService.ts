import type { PrismaClient } from "@prisma/client";
import type { World } from "../game/types";
import { generateWorld } from "../game/worldgen";

export function serializeWorld(world: World): string {
  return JSON.stringify(world);
}

export function deserializeWorld(json: string): World {
  const world = JSON.parse(json) as World;
  world.nextId ??= 1;
  world.contractWarnings ??= [];
  world.seasonSummary ??= null;
  world.auctions ??= [];
  world.news ??= [];
  for (const club of world.clubs) {
    club.ledger ??= { income: [], expense: [] };
    club.trophies ??= {};
  }
  return world;
}

export async function createSaveRecord(
  prisma: PrismaClient,
  userId: number,
  name: string,
  seed?: number
): Promise<{ id: number; clubOptions: { id: number; name: string; shortName: string; primaryColor: string; secondaryColor: string; reputation: number; level: number; division: number }[] }> {
  const world = generateWorld(seed ?? Math.floor(Math.random() * 0x7fffffff));
  const save = await prisma.save.create({
    data: {
      userId,
      name,
      worldJson: serializeWorld(world),
      year: world.year,
      dayIndex: world.dayIndex,
      humanClubId: world.humanClubId,
    },
  });
  const options = world.clubs
    .filter((c) => c.division === 1)
    .map((c) => ({
      id: c.id,
      name: c.name,
      shortName: c.shortName,
      primaryColor: c.primaryColor,
      secondaryColor: c.secondaryColor,
      reputation: c.reputation,
      level: c.level,
      division: c.division,
    }));
  return { id: save.id, clubOptions: options };
}

export async function loadWorld(prisma: PrismaClient, saveId: number, userId: number): Promise<{ save: { id: number; name: string }; world: World } | null> {
  const save = await prisma.save.findFirst({ where: { id: saveId, userId } });
  if (!save) return null;
  return { save: { id: save.id, name: save.name }, world: deserializeWorld(save.worldJson) };
}

export async function persistWorld(
  prisma: PrismaClient,
  saveId: number,
  userId: number,
  world: World
): Promise<void> {
  await prisma.save.updateMany({
    where: { id: saveId, userId },
    data: {
      worldJson: serializeWorld(world),
      year: world.year,
      dayIndex: world.dayIndex,
      humanClubId: world.humanClubId,
    },
  });
}
