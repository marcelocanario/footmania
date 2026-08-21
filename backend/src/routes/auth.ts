import { z } from "zod";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { COOKIE_NAME } from "../config";

const registerSchema = z.object({
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(72),
  inviteToken: z.string().min(16).max(128).optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input", details: parsed.error.flatten() });
    }
    const { username, password, inviteToken } = parsed.data;
    const existing = await app.prisma.user.findUnique({ where: { username } });
    if (existing) {
      return reply.code(409).send({ error: "Username already taken" });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    let user;
    try {
      user = await app.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({ data: { username, passwordHash } });
        if (inviteToken) {
          const invitation = await tx.invitation.findUnique({ where: { token: inviteToken } });
          if (!invitation || invitation.acceptedAt !== null || invitation.inviterUserId === created.id) {
            throw new Error("INVALID_INVITATION");
          }
          const userAId = Math.min(invitation.inviterUserId, created.id);
          const userBId = Math.max(invitation.inviterUserId, created.id);
          await tx.friendship.upsert({
            where: { userAId_userBId: { userAId, userBId } },
            create: { userAId, userBId },
            update: {},
          });
          await tx.invitation.update({ where: { token: inviteToken }, data: { inviteeUserId: created.id, acceptedAt: new Date() } });
        }
        return created;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_INVITATION") return reply.code(400).send({ error: "Invalid or already used invitation" });
      throw error;
    }
    const token = await app.createSession(user.id);
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

  app.post("/auth/invite", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const token = randomBytes(24).toString("hex");
    await app.prisma.invitation.create({ data: { token, inviterUserId: req.user.id } });
    return { inviteToken: token };
  });

  app.post("/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const { username, password } = parsed.data;
    const user = await app.prisma.user.findUnique({ where: { username } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    const token = await app.createSession(user.id);
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
      await app.destroySession(token);
      reply.clearCookie(COOKIE_NAME, { path: "/" });
    }
    return { ok: true };
  });

  app.get("/auth/me", async (req, reply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      return reply.code(401).send({ error: "Not authenticated" });
    }
    const session = await app.prisma.session.findUnique({ where: { token }, include: { user: true } });
    if (!session || session.expiresAt < new Date()) {
      return reply.code(401).send({ error: "Session expired" });
    }
    return { user: { id: session.userId, username: session.user.username, isAdmin: session.user.isAdmin } };
  });
}
