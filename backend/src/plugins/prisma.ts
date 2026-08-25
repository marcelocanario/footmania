import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

// better-auth needs a PrismaClient instance at import time, but the test
// harness sets DATABASE_URL *after* imports are hoisted (see integration
// test files). A lazily-created client would break better-auth, so use one
// shared client created lazily on first use, which honors whatever
// DATABASE_URL is set by the time it is actually needed (app.ready()).
let client: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

const prismaPlugin: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  await prisma.$connect();
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
};

export { getPrisma };
export default fp(prismaPlugin, { name: "prisma" });
