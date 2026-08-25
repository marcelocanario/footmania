import { describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import { MP_CONFIG } from "../src/config";
import { createTestSessionCookie } from "./testAuth";

describe("settings API", () => {
  it("exposes the pre-game prep window from MP_CONFIG to authenticated clients", async () => {
    const app = buildServer();
    await app.ready();
    try {
      const { cookie } = await createTestSessionCookie(app, { name: "Settings Reader", email: "settingsreader@test.dev" });

      const res = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.pregameWindowMinutes).toBe(MP_CONFIG.pregameWindowMinutes);
      expect(body.pregameWindowMinutes).toBeGreaterThanOrEqual(0);

      const anon = await app.inject({ method: "GET", url: "/api/settings" });
      expect(anon.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
