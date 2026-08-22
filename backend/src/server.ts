import Fastify from "fastify";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import prismaPlugin from "./plugins/prisma";
import authPlugin from "./plugins/auth";
import wsPlugin from "./plugins/ws";
import { authRoutes } from "./routes/auth";
import { multiplayerRoutes } from "./routes/multiplayer";
import { gameRoutes } from "./routes/game";
import { adminRoutes } from "./routes/admin";
import { proFeaturesRoutes } from "./routes/proFeatures";
import { startWorker } from "./services/worker";
import { ensureCurrentSeason } from "./services/mpService";
import { ensureNamePools } from "./services/namePoolService";
import { PORT, MP_CONFIG } from "./config";
import bcrypt from "bcryptjs";

export function buildServer() {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test"
      ? false
      : { level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "warn" : "info") },
    bodyLimit: 5 * 1024 * 1024,
  });

  void app.register(compress, { threshold: 1024 });
  app.addHook("onSend", async (req, reply, payload) => {
    if (!reply.getHeader("Cache-Control")) {
      if (req.url === "/api/mp/countries" || req.url === "/api/settings") {
        reply.header("Cache-Control", "private, max-age=3600");
      } else if (req.url.startsWith("/api/")) {
        reply.header("Cache-Control", "private, no-store");
      }
    }
    return payload;
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
  void app.register(multiplayerRoutes, { prefix: "/api" });
  void app.register(gameRoutes, { prefix: "/api" });
  void app.register(adminRoutes, { prefix: "/api" });
  void app.register(proFeaturesRoutes, { prefix: "/api" });

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
        await ensureNamePools(instance.prisma);
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
