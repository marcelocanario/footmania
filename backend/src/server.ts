import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import prismaPlugin from "./plugins/prisma";
import authPlugin from "./plugins/auth";
import wsPlugin from "./plugins/ws";
import { authRoutes } from "./routes/auth";
import { savesRoutes } from "./routes/saves";
import { gameRoutes } from "./routes/game";
import { PORT } from "./config";

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

  app.get("/api/health", async () => ({ ok: true }));

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildServer();
  app
    .listen({ port: PORT, host: "0.0.0.0" })
    .then(() => app.log.info(`Footmania backend listening on :${PORT}`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
