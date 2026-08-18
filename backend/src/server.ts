import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import prismaPlugin from "./plugins/prisma";
import authPlugin from "./plugins/auth";
import wsPlugin from "./plugins/ws";
import { authRoutes } from "./routes/auth";
import { savesRoutes } from "./routes/saves";
import { gameRoutes } from "./routes/game";
import { adminRoutes } from "./routes/admin";
import { startWorker } from "./services/worker";
import { ensureCurrentSeason } from "./services/mpService";
import { PORT, MP_CONFIG } from "./config";
import bcrypt from "bcryptjs";

export function buildServer() {
  const app = Fastify({
    logger: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  void app.register(cors, {
    origin: true,
    credentials: true,
  });
  void app.register(cookie);
  void app.register(prismaPlugin);
  void app.register(authPlugin);
  void app.register(wsPlugin);
  void app.register(authRoutes, { prefix: "/api" });
  void app.register(savesRoutes, { prefix: "/api" });
  void app.register(gameRoutes, { prefix: "/api" });
  void app.register(adminRoutes, { prefix: "/api" });

  app.get("/api/health", async () => ({ ok: true }));

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildServer();
  let stopWorker: (() => void) | undefined;
  app
    .register(async (instance) => {
      // Start the authoritative clock once the prisma plugin is ready.
      instance.addHook("onReady", async () => {
        await ensureAdminUser(instance.prisma);
        await ensureCurrentSeason(instance.prisma);
        stopWorker = startWorker(instance.prisma, MP_CONFIG.workerIntervalMs);
      });
      instance.addHook("onClose", async () => {
        stopWorker?.();
      });
    })
    .listen({ port: PORT, host: "0.0.0.0" })
    .then(() => app.log.info(`Footmania backend listening on :${PORT}`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

/**
 * Bootstraps an admin account for manual clock control.
 * Username/password come from ADMIN_USERNAME / ADMIN_PASSWORD (defaults
 * "admin" / "admin123"). Only ever promotes, never demotes.
 */
async function ensureAdminUser(prisma: import("@prisma/client").PrismaClient) {
  const username = process.env.ADMIN_USERNAME ?? "admin";
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (process.env.NODE_ENV === "production" && !configuredPassword) {
    throw new Error("ADMIN_PASSWORD must be set in production");
  }
  const password = configuredPassword ?? "admin123";
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    if (!existing.isAdmin) await prisma.user.update({ where: { id: existing.id }, data: { isAdmin: true } });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({ data: { username, passwordHash, isAdmin: true } });
}
