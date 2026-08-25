import Fastify from "fastify";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { fromNodeHeaders } from "better-auth/node";
import prismaPlugin from "./plugins/prisma";
import authPlugin from "./plugins/auth";
import wsPlugin from "./plugins/ws";
import { getAuth } from "./auth";
import { accountRoutes } from "./routes/account";
import { multiplayerRoutes } from "./routes/multiplayer";
import { gameRoutes } from "./routes/game";
import { adminRoutes } from "./routes/admin";
import { proFeaturesRoutes } from "./routes/proFeatures";
import { startWorker } from "./services/worker";
import { ensureCurrentSeason } from "./services/mpService";
import { ensureNamePools } from "./services/namePoolService";
import { PORT, MP_CONFIG, GOOGLE_CLIENT_ID } from "./config";

export function buildServer() {
  if (process.env.NODE_ENV === "production" && !GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID must be set in production");
  }
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

  // better-auth owns /api/auth/* (sign-in/social callbacks/get-session/sign-out).
  app.route({
    method: ["GET", "POST", "OPTIONS"],
    url: "/api/auth/*",
    async handler(request, reply) {
      try {
        const auth = getAuth();
        const url = new URL(request.url, `http://${request.headers.host}`);
        const headers = fromNodeHeaders(request.headers);
        const req = new Request(url.toString(), {
          method: request.method,
          headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        });
        const response = await auth.handler(req);
        reply.status(response.status);
        response.headers.forEach((value, key) => reply.header(key, value));
        return reply.send(response.body ? await response.text() : null);
      } catch (error) {
        app.log.error(error);
        return reply.status(500).send({ error: "Internal authentication error" });
      }
    },
  });

  void app.register(accountRoutes, { prefix: "/api/account" });
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
