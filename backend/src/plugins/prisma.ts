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
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
};

export default fp(prismaPlugin, { name: "prisma" });
