/**
 * Dev-only helper: create a better-auth session for a throwaway user WITHOUT
 * going through Google OAuth, and print a signed session cookie you can paste
 * into the browser (or an API client) to test authenticated flows.
 *
 * Usage (from backend/):
 *   node scripts/make-dev-session.mjs [email] [name]
 *
 * Defaults to a unique "dev-review-*" user when no email is given.
 * The printed cookie is a `better-auth.session_token=<token>.<hmac>` value.
 *
 * Note: the backend must be running with the SAME BETTER_AUTH_SECRET that this
 * script uses to sign the cookie. If the server was started without
 * BETTER_AUTH_SECRET, better-auth falls back to its built-in default
 * (`better-auth-secret-12345678901234567890`); pass that same value here via
 * the BETTER_AUTH_SECRET env var when signing.
 */
import { PrismaClient } from "@prisma/client";
import { createHmac } from "node:crypto";

const email = process.argv[2] ?? `dev-review-${Date.now()}@example.com`;
const name = process.argv[3] ?? "Dev Review User";

// Default better-auth secret used when BETTER_AUTH_SECRET is unset
// (see backend/node_modules/better-auth/dist/context/create-context.mjs).
const secret = process.env.BETTER_AUTH_SECRET ?? "better-auth-secret-12345678901234567890";

const prisma = new PrismaClient();

try {
  const user = await prisma.user.upsert({
    where: { email },
    create: { name, email, emailVerified: true },
    update: { name },
  });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  const token = `dev-session-${user.id}-${Math.random().toString(36).slice(2, 12)}`;
  await prisma.session.create({
    data: { userId: user.id, token, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
  // better-auth signs the session cookie as `<token>.<base64(HMAC-SHA256)>`
  // (see better-call/dist/crypto.mjs signCookieValue) and URL-encodes it.
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  const cookie = encodeURIComponent(`${token}.${signature}`);
  console.log(JSON.stringify({ userId: user.id, email, name, cookie: `better-auth.session_token=${cookie}` }));
} finally {
  await prisma.$disconnect();
}
