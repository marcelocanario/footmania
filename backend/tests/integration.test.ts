import { execSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.DATABASE_URL = "file:./test.db";
process.env.NODE_ENV = "test";

const here = dirname(fileURLToPath(import.meta.url));
beforeAll(() => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: join(here, ".."),
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "ignore",
  });
});

import { buildServer } from "../src/server";

describe("API flow", () => {
  it("registers, creates a save, starts it, and advances days", async () => {
    const app = buildServer();
    await app.ready();

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "player1", password: "secret123" },
    });
    expect(register.statusCode).toBe(200);
    const setCookie = register.headers["set-cookie"] as string;
    const cookie = setCookie.split(";")[0];

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("player1");

    const create = await app.inject({
      method: "POST",
      url: "/api/saves",
      headers: { cookie },
      payload: { name: "My Career", seed: 1234 },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json();
    expect(created.clubOptions.length).toBe(20);
    const saveId = created.id;

    const start = await app.inject({
      method: "POST",
      url: `/api/saves/${saveId}/start`,
      headers: { cookie },
      payload: { clubId: created.clubOptions[0].id },
    });
    expect(start.statusCode).toBe(200);

    const state0 = await app.inject({ method: "GET", url: `/api/saves/${saveId}/state`, headers: { cookie } });
    expect(state0.statusCode).toBe(200);
    expect(state0.json().started).toBe(true);
    expect(state0.json().snapshot.club.name).toBeTruthy();

    let advanced = false;
    for (let i = 0; i < 10; i++) {
      const adv = await app.inject({ method: "POST", url: `/api/saves/${saveId}/advance`, headers: { cookie } });
      expect(adv.statusCode).toBe(200);
      const body = adv.json();
      if (body.playedMatches.length > 0) {
        advanced = true;
        break;
      }
    }
    expect(advanced).toBe(true);

    const state1 = await app.inject({ method: "GET", url: `/api/saves/${saveId}/state`, headers: { cookie } });
    expect(state1.statusCode).toBe(200);
    expect(state1.json().snapshot.competitions.length).toBe(4);

    await app.close();
  });

  it("rejects bad credentials", async () => {
    const app = buildServer();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
