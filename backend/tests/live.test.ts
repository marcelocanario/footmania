import { execSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

process.env.DATABASE_URL = "file:./test-live.db";
process.env.NODE_ENV = "test";

const here = dirname(fileURLToPath(import.meta.url));
beforeAll(() => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: join(here, ".."),
    env: { ...process.env, DATABASE_URL: "file:./test-live.db" },
    stdio: "ignore",
  });
});

import { buildServer } from "../src/server";
import type { FastifyInstance } from "fastify";

async function setupCareer(app: FastifyInstance, username: string) {
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "secret123" },
  });
  expect(register.statusCode).toBe(200);
  const cookie = (register.headers["set-cookie"] as string).split(";")[0];
  const create = await app.inject({
    method: "POST",
    url: "/api/saves",
    headers: { cookie },
    payload: { name: "WS Career", seed: 4242 },
  });
  const saveId = create.json().id;
  await app.inject({
    method: "POST",
    url: `/api/saves/${saveId}/start`,
    headers: { cookie },
    payload: { clubId: create.json().clubOptions[0].id },
  });
  return { cookie, saveId };
}

async function advanceUntilMatch(app: FastifyInstance, cookie: string, saveId: number) {
  for (let i = 0; i < 60; i++) {
    const adv = await app.inject({ method: "POST", url: `/api/saves/${saveId}/advance`, headers: { cookie } });
    expect(adv.statusCode).toBe(200);
    const body = adv.json();
    if (body.matchPending) return body;
  }
  throw new Error("no match day reached");
}

describe("live match over REST", () => {
  it("streams the match by ticking, enforces subs, and finalizes the day", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie, saveId } = await setupCareer(app, "restplayer");
    const day = await advanceUntilMatch(app, cookie, saveId);
    const matchId = day.humanMatch.id;
    expect(day.humanMatch.homeScore).toBe(0);

    const live0 = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live?saveId=${saveId}`, headers: { cookie } });
    expect(live0.statusCode).toBe(200);
    const s0 = live0.json().state;
    expect(s0.phase).toBe("pregame");
    expect(s0.minute).toBe(0);
    expect(s0.homeOn.length).toBe(11);
    expect(s0.homeBench.length).toBeGreaterThan(0);

    let state = s0;
    let ticks = 0;
    while (!state.ended && ticks < 40) {
      const res = await app.inject({
        method: "POST",
        url: `/api/matches/${matchId}/tick?saveId=${saveId}`,
        headers: { cookie },
        payload: { minutes: 5, resume: true },
      });
      expect(res.statusCode).toBe(200);
      state = res.json().state;
      ticks++;
    }
    expect(state.ended).toBe(true);
    expect(state.events.length).toBeGreaterThanOrEqual(0);
    expect(state.phase).toBe("fulltime");

    const finish = await app.inject({ method: "POST", url: `/api/matches/${matchId}/finish?saveId=${saveId}`, headers: { cookie } });
    expect(finish.statusCode).toBe(200);
    const dayResult = finish.json().dayResult;
    expect(dayResult.humanMatch).toBeTruthy();
    expect(dayResult.matchPending).toBe(false);

    const adv = await app.inject({ method: "POST", url: `/api/saves/${saveId}/advance`, headers: { cookie } });
    expect(adv.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a substitution of a player not on the pitch", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie, saveId } = await setupCareer(app, "restplayer2");
    const day = await advanceUntilMatch(app, cookie, saveId);
    const matchId = day.humanMatch.id;
    const live = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live?saveId=${saveId}`, headers: { cookie } });
    const s = live.json().state;
    const onPitch = s.humanSide === 0 ? s.homeOn : s.awayOn;
    const bench = s.humanSide === 0 ? s.homeBench : s.awayBench;
    const bad = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/sub?saveId=${saveId}`,
      headers: { cookie },
      payload: { outId: bench[0].id, inId: onPitch[0].id },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/sub?saveId=${saveId}`,
      headers: { cookie },
      payload: { outId: onPitch[1].id, inId: bench[0].id },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().state.usedSubs[s.humanSide]).toBe(1);
    await app.close();
  });
  it("lets the manager set the roster before kickoff, then locks it", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie, saveId } = await setupCareer(app, "restplayer3");
    const day = await advanceUntilMatch(app, cookie, saveId);
    const matchId = day.humanMatch.id;
    const live = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live?saveId=${saveId}`, headers: { cookie } });
    expect(live.statusCode).toBe(200);
    const s = live.json().state;
    expect(s.phase).toBe("pregame");
    const onPitch = s.humanSide === 0 ? s.homeOn : s.awayOn;
    const bench = s.humanSide === 0 ? s.homeBench : s.awayBench;
    expect(onPitch.length).toBe(11);
    expect(bench.length).toBeGreaterThan(0);
    const starters = onPitch.map((p: { id: number }) => p.id);
    const subs = bench.map((p: { id: number }) => p.id);
    const swappedOut = starters[1];
    const swappedIn = subs[0];
    const newStarters = starters.slice();
    newStarters[1] = swappedIn;
    const newSubs = subs.slice();
    newSubs[0] = swappedOut;
    const lineupRes = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/lineup?saveId=${saveId}`,
      headers: { cookie },
      payload: { formation: 4, starters: newStarters, subs: newSubs, penaltyTakerId: null, freeKickTakerId: null },
    });
    expect(lineupRes.statusCode).toBe(200);
    const after = lineupRes.json().state;
    const afterPitch = (after.humanSide === 0 ? after.homeOn : after.awayOn).map((p: { id: number }) => p.id);
    expect(afterPitch).toContain(swappedIn);
    expect(afterPitch).not.toContain(swappedOut);
    const tick1 = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/tick?saveId=${saveId}`,
      headers: { cookie },
      payload: { minutes: 1 },
    });
    expect(tick1.statusCode).toBe(200);
    expect(tick1.json().state.phase).toBe("first");
    const locked = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/lineup?saveId=${saveId}`,
      headers: { cookie },
      payload: { formation: 4, starters: newStarters, subs: newSubs, penaltyTakerId: null, freeKickTakerId: null },
    });
    expect(locked.statusCode).toBe(400);
    await app.close();
  });
});

describe("live match over WebSocket", () => {
  it("streams tick updates and a finished message over the socket", async () => {
    const app = buildServer();
    await app.ready();
    const port = await app.listen({ port: 0, host: "127.0.0.1" });
    const { cookie, saveId } = await setupCareer(app, "wsplayer");
    const day = await advanceUntilMatch(app, cookie, saveId);
    const matchId = day.humanMatch.id;
    const url = `ws://127.0.0.1:${new URL(port).port}/api/matches/${matchId}/ws?saveId=${saveId}`;

    const ws = new WebSocket(url, { headers: { cookie } });
    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await opened;

    const messages: Record<string, unknown>[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    const waitFor = (type: string, timeoutMs = 8000) =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const iv = setInterval(() => {
          if (messages.some((m) => m.type === type)) {
            clearInterval(iv);
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(iv);
            reject(new Error(`timeout waiting for ${type}`));
          }
        }, 40);
      });

    const waitForTickEnded = (msgs: Record<string, unknown>[], timeoutMs = 10000) =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const iv = setInterval(() => {
          const last = [...msgs].reverse().find((m) => m.type === "tick")?.state as { ended?: boolean } | undefined;
          if (last?.ended) {
            clearInterval(iv);
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(iv);
            reject(new Error("timeout waiting for match end over ws"));
          }
        }, 40);
      });

    ws.send(JSON.stringify({ type: "state" }));
    await waitFor("state");
    const s0 = messages.find((m) => m.type === "state")!.state as { phase: string; minute: number; homeOn: unknown[]; homeBench: unknown[] };
    expect(s0.phase).toBe("pregame");

    let sent = 0;
    while (sent < 30) {
      ws.send(JSON.stringify({ type: "tick", minutes: 4, resume: true }));
      sent++;
      await new Promise((r) => setTimeout(r, 30));
      const latest = [...messages].reverse().find((m) => m.type === "tick")?.state as { ended: boolean } | undefined;
      if (latest?.ended) break;
    }
    await waitForTickEnded(messages, 10000);
    const final = [...messages].reverse().find((m) => m.type === "tick")?.state as { ended: boolean; phase: string } | undefined;
    expect(final?.ended).toBe(true);

    ws.send(JSON.stringify({ type: "finish" }));
    await waitFor("finished", 10000);
    const fin = messages.find((m) => m.type === "finished") as { dayResult: { humanMatch: unknown; matchPending: boolean } };
    expect(fin.dayResult.humanMatch).toBeTruthy();
    expect(fin.dayResult.matchPending).toBe(false);

    ws.close();
    await app.close();
  });
});
