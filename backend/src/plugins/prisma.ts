import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

const prismaPlugin: FastifyPluginAsync = async (app) => {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  } catch (error) {
    app.log.warn({ error }, "SQLite performance pragmas could not be applied");
  }
  const legacyLiveRows = await prisma.liveMatch.findMany({
    where: { OR: [{ homeClubId: null }, { awayClubId: null }] },
    select: { saveId: true, matchId: true, stateJson: true },
  });
  const backfills = legacyLiveRows.flatMap((row) => {
    try {
      const state = JSON.parse(row.stateJson) as { homeClubId?: unknown; awayClubId?: unknown };
      const homeClubId = typeof state.homeClubId === "number" ? state.homeClubId : null;
      const awayClubId = typeof state.awayClubId === "number" ? state.awayClubId : null;
      if (homeClubId === null && awayClubId === null) return [];
      return [prisma.liveMatch.update({ where: { saveId_matchId: { saveId: row.saveId, matchId: row.matchId } }, data: { homeClubId, awayClubId } })];
    } catch {
      return [];
    }
  });
  if (backfills.length > 0) await prisma.$transaction(backfills);
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
};

export default fp(prismaPlugin, { name: "prisma" });
