import fp from "fastify-plugin";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { getAuth } from "../auth";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    destroySession: (token: string) => Promise<void>;
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate("destroySession", async (token: string) => {
    // better-auth stores sessions by id; token lookup + delete is safe.
    const session = await app.prisma.session.findUnique({ where: { token } });
    if (session) await app.prisma.session.delete({ where: { id: session.id } });
  });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const session = await getAuth().api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      return reply.code(401).send({ error: "Not authenticated" });
    }
    if (session.user.bannedAt) {
      return reply.code(403).send({ error: "Account banned", reason: session.user.banReason ?? null });
    }
    req.user = {
      id: Number(session.user.id),
      name: session.user.name,
      email: session.user.email,
      isAdmin: Boolean(session.user.isAdmin),
      isPro: Boolean(session.user.isPro || session.user.isAdmin),
    };
    req.sessionToken = session.session.token;
  });
};

export default fp(authPlugin, { name: "auth" });
