import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "../auth";
import { withGlobalLock } from "../services/lock";
import { notifyFriendshipsChanged } from "../services/saveService";

// Game-domain account endpoints. Authentication (Google via better-auth) owns
// /api/auth/*; this file exposes account-scoped game features and a
// better-auth-backed /me + /logout for the SPA.

function toUserView(u: { id: number | string; name: string; email: string; isAdmin: boolean; isPro: boolean; bannedAt?: Date | null; banReason?: string | null }) {
  return { id: Number(u.id), name: u.name, email: u.email, isAdmin: u.isAdmin, isPro: Boolean(u.isPro || u.isAdmin), bannedAt: u.bannedAt ?? null, banReason: u.banReason ?? null };
}

export async function accountRoutes(app: FastifyInstance) {
  app.get("/me", async (req, reply) => {
    const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return reply.code(401).send({ error: "Not authenticated" });
    if (session.user.bannedAt) {
      return reply.code(403).send({ error: "Account banned", reason: session.user.banReason ?? null });
    }
    return { user: toUserView(session.user as never) };
  });

  app.post("/logout", async (req, reply) => {
    await getAuth().api.signOut({ headers: fromNodeHeaders(req.headers) });
    return { ok: true };
  });

  // Accept a pending invitation AFTER the account exists (Google sign-up flow):
  // the client stashes the invite token before redirecting to Google and calls
  // this once the session is live. Same rules as the legacy register path:
  // token must exist, be unused, and not self-invited.
  app.post("/invite/accept", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const parsed = z.object({ token: z.string().min(16).max(128) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const { token } = parsed.data;
    let friendshipCreated = false;
    const invitation = await app.prisma.invitation.findUnique({ where: { token } });
    if (!invitation || invitation.acceptedAt !== null || invitation.inviterUserId === req.user.id) {
      return reply.code(400).send({ error: "Invalid or already used invitation" });
    }
    await app.prisma.$transaction(async (tx) => {
      const userAId = Math.min(invitation.inviterUserId, req.user!.id);
      const userBId = Math.max(invitation.inviterUserId, req.user!.id);
      await tx.friendship.upsert({
        where: { userAId_userBId: { userAId, userBId } },
        create: { userAId, userBId },
        update: {},
      });
      await tx.invitation.update({ where: { token }, data: { inviteeUserId: req.user!.id, acceptedAt: new Date() } });
      friendshipCreated = true;
    });
    // The new edge must reach World.friendships before the next season's
    // regrouping reads it; bump the revision so cached worlds rebuild.
    if (friendshipCreated) await withGlobalLock(() => notifyFriendshipsChanged(app.prisma));
    return { ok: true };
  });

  // --- Friends management (plan 9) -----------------------------------------
  // Friendships are account-level data managed here; they only influence
  // season regrouping when both owners kept friend-grouping enabled
  // (see game/multiplayer.ts calculateSocialScore).

  // Accepted friends of the current user, with their global-world club name.
  app.get("/friends", async (req, reply) => {
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
    const users = await app.prisma.user.findMany({ where: { id: { in: friendIds } }, select: { id: true, name: true } });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const save = await app.prisma.save.findFirst({ where: { isGlobal: true }, select: { id: true } });
    const clubRows = save
      ? await app.prisma.club.findMany({ where: { saveId: save.id, ownerUserId: { in: friendIds } }, select: { ownerUserId: true, id: true, name: true, competitionState: true } })
      : [];
    const clubByUser = new Map(clubRows.filter((c) => c.ownerUserId !== null).map((c) => [c.ownerUserId!, c]));
    return {
      friends: friendIds.map((userId) => ({
        userId,
        name: nameById.get(userId) ?? `#${userId}`,
        // Club id so clients can link the friend's team to the team screen.
        clubId: clubByUser.get(userId)?.id ?? null,
        clubName: clubByUser.get(userId)?.name ?? null,
        competitionState: clubByUser.get(userId)?.competitionState ?? null,
        since: sinceByFriend.get(userId)!.toISOString(),
      })),
    };
  });

  // Sever an accepted friendship (either side may remove it).
  app.delete("/friends/:userId", async (req, reply) => {
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
    // Severed edges must leave World.friendships too (see /invite/accept).
    await withGlobalLock(() => notifyFriendshipsChanged(app.prisma));
    return { ok: true };
  });

  // Pending (unused) invitations created by the current user.
  app.get("/invitations", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const rows = await app.prisma.invitation.findMany({
      where: { inviterUserId: req.user.id, acceptedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return { invitations: rows.map((r) => ({ token: r.token, createdAt: r.createdAt.toISOString() })) };
  });

  // Create a new invitation link for a friend.
  app.post("/invite", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const token = (await import("node:crypto")).randomBytes(24).toString("hex");
    await app.prisma.invitation.create({ data: { token, inviterUserId: req.user.id } });
    return { inviteToken: token };
  });

  // Revoke a pending invitation. Already-accepted tokens are history and stay.
  app.delete("/invitations/:token", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const token = (req.params as { token: string }).token;
    const invitation = await app.prisma.invitation.findUnique({ where: { token } });
    if (!invitation || invitation.inviterUserId !== req.user.id) return reply.code(404).send({ error: "Not found" });
    if (invitation.acceptedAt) return reply.code(400).send({ error: "Invitation already used" });
    await app.prisma.invitation.delete({ where: { token } });
    return { ok: true };
  });

  // Warnings for the current user (own warnings only)
  app.get("/warnings", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const warnings = await app.prisma.warning.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 50 });
    return { warnings: warnings.map((w) => ({ id: w.id, reason: w.reason, createdAt: w.createdAt.toISOString(), acknowledgedAt: w.acknowledgedAt?.toISOString() ?? null })) };
  });

  app.post("/warnings/:id/acknowledge", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const id = Number((req.params as { id: string }).id);
    const w = await app.prisma.warning.findUnique({ where: { id } });
    if (!w || w.userId !== req.user.id) return reply.code(404).send({ error: "Not found" });
    if (!w.acknowledgedAt) await app.prisma.warning.update({ where: { id }, data: { acknowledgedAt: new Date() } });
    return { ok: true };
  });
}
