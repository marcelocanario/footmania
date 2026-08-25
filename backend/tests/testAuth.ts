import type { FastifyInstance } from "fastify";
import { getAuth } from "../src/auth";
import { getPrisma } from "../src/plugins/prisma";

/**
 * Creates a real better-auth session for a test user (no Google involved) and
 * returns a properly-signed session cookie plus the user id. Emails must be
 * unique per test file (integration suites share one database schema).
 */
export async function createTestSessionCookie(
  app: FastifyInstance,
  opts: { name: string; email: string },
): Promise<{ cookie: string; userId: number }> {
  const prisma = app.prisma ?? getPrisma();
  // Upsert by email so a leftover row from a previous run/file cannot crash
  // the helper with a unique-constraint violation.
  const user = await prisma.user.upsert({
    where: { email: opts.email },
    create: { name: opts.name, email: opts.email, emailVerified: true },
    update: { name: opts.name },
  });
  const token = `test-session-${user.id}-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.session.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  const ctx = await getAuth().$context;
  // better-auth signs its session cookie as `<token>.<hmac-sha256-signature>`.
  // Reuse the same WebCrypto HMAC so getSession accepts the test cookie.
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    enc.encode(ctx.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await subtle.sign("HMAC", key, enc.encode(token));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return { cookie: `better-auth.session_token=${token}.${signature}`, userId: user.id };
}
