import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { getPrisma } from "./plugins/prisma";
import { BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_ORIGIN, SESSION_TTL_DAYS } from "./config";

// Read lazily: the test harness sets ADMIN_EMAIL after ES module imports are
// hoisted, so a module-scope const would always see undefined in tests.
export function adminEmail(): string | undefined {
  return process.env.ADMIN_EMAIL;
}

/**
 * Single authentication instance. Google is the only sign-in method; the
 * verified email is the account key, and better-auth's default account
 * linking means a future provider (e.g. Facebook) whose verified email
 * matches an existing user logs into the SAME account instead of creating a
 * duplicate. Admin rights come from ADMIN_EMAIL (promote-only, applied on
 * every sign-in below). The session cookie is set by better-auth itself.
 *
 * Built lazily inside getAuth() so the PrismaClient honors the DATABASE_URL
 * that is in effect when the server actually boots (the integration test
 * harness sets TEST_DATABASE_URL after ES module imports are hoisted).
 */

function buildAuthConfig() {
  return {
    database: prismaAdapter(getPrisma(), { provider: "postgresql" }),
    secret: BETTER_AUTH_SECRET,
    basePath: "/api/auth",
    baseURL: PUBLIC_ORIGIN,
    trustedOrigins: [PUBLIC_ORIGIN],
    advanced: {
      database: {
        // Keep Int auto-increment ids: every game table references User.id.
        generateId: "serial" as const,
      },
    },
    user: {
      modelName: "User" as const,
      additionalFields: {
        isAdmin: { type: "boolean" as const, required: false, defaultValue: false, input: false },
        isPro: { type: "boolean" as const, required: false, defaultValue: false, input: false },
        bannedAt: { type: "date" as const, required: false, input: false },
        banReason: { type: "string" as const, required: false, input: false },
      },
    },
    session: {
      modelName: "Session" as const,
      expiresIn: SESSION_TTL_DAYS * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    account: {
      modelName: "Account" as const,
    },
    verification: {
      modelName: "Verification" as const,
    },
    socialProviders: {
      google: {
        clientId: GOOGLE_CLIENT_ID ?? "",
        clientSecret: GOOGLE_CLIENT_SECRET ?? "",
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session: { userId: string | number }) => {
            await promoteAdminIfNeeded(Number(session.userId));
          },
        },
      },
    },
  };
}

/**
 * Promote-only admin grant: the Google account matching ADMIN_EMAIL is an
 * admin. Never demotes. Runs from better-auth's session.create after-hook
 * (every sign-in) and is exported so tests can drive the same rule.
 */
export async function promoteAdminIfNeeded(userId: number): Promise<void> {
  const configured = adminEmail();
  if (!configured) return;
  const user = await getPrisma().user.findUnique({ where: { id: userId } });
  if (user && user.email === configured && !user.isAdmin) {
    await getPrisma().user.update({ where: { id: user.id }, data: { isAdmin: true } });
  }
}

let authInstance: ReturnType<typeof betterAuth<ReturnType<typeof buildAuthConfig>>> | null = null;

export function getAuth() {
  authInstance ??= betterAuth(buildAuthConfig());
  return authInstance;
}
