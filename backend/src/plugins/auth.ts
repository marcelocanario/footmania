import fp from "fastify-plugin";
import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_TTL_DAYS } from "../config";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    createSession: (userId: number) => Promise<string>;
    destroySession: (token: string) => Promise<void>;
  }
}

const COOKIE_NAME = "fm_session";

const authPlugin: FastifyPluginAsync = async (app) => {
  const ttlMs = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

  app.decorate("createSession", async (userId: number) => {
    const token = randomBytes(32).toString("hex");
    await app.prisma.session.create({
      data: {
        token,
        userId,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return token;
  });

  app.decorate("destroySession", async (token: string) => {
    await app.prisma.session.deleteMany({ where: { token } });
  });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      return reply.code(401).send({ error: "Not authenticated" });
    }
    const session = await app.prisma.session.findUnique({
      where: { token },
      include: { user: true },
    });
    if (!session || session.expiresAt < new Date()) {
      return reply.code(401).send({ error: "Session expired" });
    }
    if (session.user.bannedAt) {
      return reply.code(403).send({ error: "Account banned", reason: session.user.banReason ?? null });
    }
    req.user = { id: session.userId, username: session.user.username, isAdmin: session.user.isAdmin, isPro: Boolean(session.user.isPro || session.user.isAdmin) };
    req.sessionToken = token;
  });
};

export default fp(authPlugin, { name: "auth" });
