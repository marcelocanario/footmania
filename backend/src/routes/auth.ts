import { z } from "zod";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { COOKIE_NAME } from "../config";
import { withGlobalLock } from "../services/lock";
import { notifyFriendshipsChanged } from "../services/saveService";

const registerSchema = z.object({
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(72),
  inviteToken: z.string().min(16).max(128).optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

function toUserView(u: { id: number; username: string; isAdmin: boolean; isPro: boolean; bannedAt?: Date | null; banReason?: string | null }) {
  return { id: u.id, username: u.username, isAdmin: u.isAdmin, isPro: Boolean(u.isPro || u.isAdmin), bannedAt: u.bannedAt ?? null, banReason: u.banReason ?? null };
}

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
    let friendshipCreated = false;
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
          friendshipCreated = true;
        }
        return created;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_INVITATION") return reply.code(400).send({ error: "Invalid or already used invitation" });
      throw error;
    }
    // The new edge must reach World.friendships before the next season's
    // regrouping reads it; bump the revision so cached worlds rebuild.
    if (friendshipCreated) await withGlobalLock(() => notifyFriendshipsChanged(app.prisma));
    const token = await app.createSession(user.id);
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
    return { user: toUserView(user as never) };
  });

  app.post("/auth/invite", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const token = randomBytes(24).toString("hex");
    await app.prisma.invitation.create({ data: { token, inviterUserId: req.user.id } });
    return { inviteToken: token };
  });

  // --- Friends management (plan 9) -----------------------------------------
  // Friendships are account-level data managed here; they only influence
  // season regrouping when both owners kept friend-grouping enabled
  // (see game/multiplayer.ts calculateSocialScore).

  // Accepted friends of the current user, with their global-world club name.
  app.get("/auth/friends", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const rows = await app.prisma.friendship.findMany({
      where: { OR: [{ userAId: req.user.id }, { userBId: req.user.id }] },
      orderBy: { id: "asc" },
    });
    const sinceByFriend = new Map<number, Date>();
    for (const row of rows) {
      const friendId = row.userAId === req.user.id ? row.userBId : row.userAId;
      sinceByFriend.set(friendId, row.createdAt);
    }
    const friendIds = [...sinceByFriend.keys()];
    const users = await app.prisma.user.findMany({ where: { id: { in: friendIds } }, select: { id: true, username: true } });
    const usernameById = new Map(users.map((u) => [u.id, u.username]));
    const save = await app.prisma.save.findFirst({ where: { isGlobal: true }, select: { id: true } });
    const clubRows = save
      ? await app.prisma.club.findMany({ where: { saveId: save.id, ownerUserId: { in: friendIds } }, select: { ownerUserId: true, name: true, competitionState: true } })
      : [];
    const clubByUser = new Map(clubRows.filter((c) => c.ownerUserId !== null).map((c) => [c.ownerUserId!, c]));
    return {
      friends: friendIds.map((userId) => ({
        userId,
        username: usernameById.get(userId) ?? `#${userId}`,
        clubName: clubByUser.get(userId)?.name ?? null,
        competitionState: clubByUser.get(userId)?.competitionState ?? null,
        since: sinceByFriend.get(userId)!.toISOString(),
      })),
    };
  });

  // Sever an accepted friendship (either side may remove it).
  app.delete("/auth/friends/:userId", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const otherId = Number((req.params as { userId: string }).userId);
    if (!Number.isInteger(otherId) || otherId <= 0 || otherId === req.user.id) {
      return reply.code(400).send({ error: "Invalid user" });
    }
    const userAId = Math.min(req.user.id, otherId);
    const userBId = Math.max(req.user.id, otherId);
    const existing = await app.prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.friendship.delete({ where: { id: existing.id } });
    // Severed edges must leave World.friendships too (see /auth/register).
    await withGlobalLock(() => notifyFriendshipsChanged(app.prisma));
    return { ok: true };
  });

  // Pending (unused) invitations created by the current user.
  app.get("/auth/invitations", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const rows = await app.prisma.invitation.findMany({
      where: { inviterUserId: req.user.id, acceptedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return { invitations: rows.map((r) => ({ token: r.token, createdAt: r.createdAt.toISOString() })) };
  });

  // Revoke a pending invitation. Already-accepted tokens are history and stay.
  app.delete("/auth/invitations/:token", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const token = (req.params as { token: string }).token;
    const invitation = await app.prisma.invitation.findUnique({ where: { token } });
    if (!invitation || invitation.inviterUserId !== req.user.id) return reply.code(404).send({ error: "Not found" });
    if (invitation.acceptedAt) return reply.code(400).send({ error: "Invitation already used" });
    await app.prisma.invitation.delete({ where: { token } });
    return { ok: true };
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
    if (user.bannedAt) {
      return reply.code(403).send({ error: "Account banned", reason: user.banReason ?? null });
    }
    const token = await app.createSession(user.id);
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
    return { user: toUserView(user as never) };
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
    if (session.user.bannedAt) {
      return reply.code(403).send({ error: "Account banned", reason: session.user.banReason ?? null });
    }
    return { user: toUserView(session.user as never) };
  });

  // Warnings for the current user (own warnings only)
  app.get("/auth/warnings", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const warnings = await app.prisma.warning.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 50 });
    return { warnings: warnings.map((w) => ({ id: w.id, reason: w.reason, createdAt: w.createdAt.toISOString(), acknowledgedAt: w.acknowledgedAt?.toISOString() ?? null })) };
  });

  app.post("/auth/warnings/:id/acknowledge", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const id = Number((req.params as { id: string }).id);
    const w = await app.prisma.warning.findUnique({ where: { id } });
    if (!w || w.userId !== req.user.id) return reply.code(404).send({ error: "Not found" });
    if (!w.acknowledgedAt) await app.prisma.warning.update({ where: { id }, data: { acknowledgedAt: new Date() } });
    return { ok: true };
  });
}
