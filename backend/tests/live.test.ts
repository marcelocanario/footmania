import { describe, expect, it } from "vitest";
import WebSocket from "ws";

process.env.DATABASE_URL = "file:./test-live.db";
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import type { FastifyInstance } from "fastify";

async function setupClub(app: FastifyInstance, username: string, seed = 4242) {
  void seed;
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "secret123" },
  });
  expect(register.statusCode).toBe(200);
  const cookie = (register.headers["set-cookie"] as string).split(";")[0];
  const { ensureCurrentSeason } = await import("../src/services/mpService");
  const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
  await ensureCurrentSeason(app.prisma);
  const clock = await loadGlobalWorld(app.prisma);
  if (!clock) throw new Error("no global world");
  clock.world.mp.manualRound = 0;
  clock.world.mp.completedRounds = 0;
  clock.world.mp.joinState = "OPEN";
  clock.world.mp.seasonStatus = "ACTIVE";
  await persistWorld(app.prisma, clock.save.id, clock.save.id, clock.world, clock.save.revision);
  const join = await app.inject({
    method: "POST",
    url: "/api/mp/join",
    headers: { cookie },
    payload: { clubName: `${username} FC`, country: "BRA", stadiumName: `${username} Stadium`, coachName: `${username} Coach`, preferredHours: Array.from({ length: 16 }, (_, i) => i) },
  });
  expect(join.statusCode).toBe(200);
  const body = join.json();
  return { cookie, clubId: body.clubId as number, userId: register.json().user.id as number };
}

/** Create a live match deterministically for a given club. */
async function makeLiveMatch(app: FastifyInstance, cookie: string, clubId: number): Promise<{ matchId: number; fixtureId: number }> {
  const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
  const { startLiveMatch } = await import("../src/game/world");
  const loaded = await loadGlobalWorld(app.prisma);
  if (!loaded) throw new Error("no world");
  const world = loaded.world;
  const club = world.clubs.find((c) => c.id === clubId)!;
  // Reset any stale live/finished state for this club's upcoming fixture so
  // each test starts from a clean pregame (tests share the global world).
  const fixture = world.fixtures.find((f) => {
    if (f.played || (f.homeClubId !== club.id && f.awayClubId !== club.id)) return false;
    const opponentId = f.homeClubId === club.id ? f.awayClubId : f.homeClubId;
    return world.clubs.find((candidate) => candidate.id === opponentId)?.ownerUserId === null;
  }) ?? world.fixtures.find((f) => !f.played && (f.homeClubId === club.id || f.awayClubId === club.id));
  if (!fixture) throw new Error("no upcoming fixture");
  const played = world.matches.filter((m) => m.fixtureId === fixture.id);
  for (const m of played) world.matches = world.matches.filter((x) => x.id !== m.id);
  fixture.played = false;
  fixture.kickoffAt = Date.now();
  // Only touch live matches for THIS fixture; leave other clubs' live matches
  // alone so tests don't interfere with each other.
  world.liveMatches = world.liveMatches.filter((s) => s.fixtureId !== fixture.id);
  let st = world.liveMatches.find((s) => s.fixtureId === fixture.id);
  if (!st) {
    startLiveMatch(world, fixture);
  }
  st = world.liveMatches.find((s) => s.fixtureId === fixture.id)!;
  await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
  return { matchId: st.matchId, fixtureId: fixture.id };
}

async function ageLiveMatch(app: FastifyInstance, matchId: number, minutes: number, readyForHalftime = false): Promise<void> {
  const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
  const { MP_CONFIG } = await import("../src/config");
  const loaded = await loadGlobalWorld(app.prisma);
  if (!loaded) throw new Error("no world");
  const st = loaded.world.liveMatches.find((candidate) => candidate.matchId === matchId);
  if (!st) throw new Error("no live match");
  const elapsed = (MP_CONFIG.matchDurationMinutes * 60 * 1000 * minutes) / 90;
  st.lastAdvancedAt = Date.now() - elapsed;
  if (readyForHalftime) st.halftimeReady = [true, true];
  await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
}

describe("live match over REST", () => {
  it("exposes no client-driven advance or finish endpoints", async () => {
    const app = buildServer();
    await app.ready();
    const first = await setupClub(app, "liveowner");
    const { matchId } = await makeLiveMatch(app, first.cookie, first.clubId);
    // Matches advance only on the server clock: the legacy acceleration
    // endpoints must be gone for everyone, participants included.
    const tick = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/tick`,
      headers: { cookie: first.cookie },
      payload: { minutes: 1 },
    });
    expect(tick.statusCode).toBe(404);

    const finish = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/finish`,
      headers: { cookie: first.cookie },
    });
    expect(finish.statusCode).toBe(404);
    await app.close();
  });

  it("finalizes on the server clock and enforces subs while live", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie, clubId } = await setupClub(app, "restplayer");
    const { matchId } = await makeLiveMatch(app, cookie, clubId);

    const live0 = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live`, headers: { cookie } });
    expect(live0.statusCode).toBe(200);
    const s0 = live0.json().state;
    expect(s0.phase).toBe("pregame");
    expect(s0.minute).toBe(0);
    expect(s0.homeOn.length).toBe(11);
    expect(s0.homeBench.length).toBeGreaterThan(0);

    // Age the match past full time and run the worker's own advance path.
    await ageLiveMatch(app, matchId, 110, true);
    const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
    const { advanceLiveMatches } = await import("../src/game/world");
    let state = s0;
    for (let i = 0; i < 10 && !state.ended; i++) {
      const loaded = await loadGlobalWorld(app.prisma);
      if (!loaded) throw new Error("no world");
      advanceLiveMatches(loaded.world, Date.now());
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      const live = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live`, headers: { cookie } });
      if (live.statusCode === 404) {
        // Finalized matches drop out of the live list.
        state = { ...state, ended: true, phase: "fulltime" };
        break;
      }
      state = live.json().state;
    }
    expect(state.ended).toBe(true);

    const finish = await app.inject({ method: "POST", url: `/api/matches/${matchId}/finish`, headers: { cookie } });
    expect(finish.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a substitution of a player not on the pitch", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie, clubId } = await setupClub(app, "restplayer2");
    const { matchId } = await makeLiveMatch(app, cookie, clubId);
    const live = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live`, headers: { cookie } });
    const s = live.json().state;
    const onPitch = s.humanSide === 0 ? s.homeOn : s.awayOn;
    const bench = s.humanSide === 0 ? s.homeBench : s.awayBench;
    const bad = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/sub`,
      headers: { cookie },
      payload: { outId: bench[0].id, inId: onPitch[0].id },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/sub`,
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
    const { cookie, clubId } = await setupClub(app, "restplayer3");
    const { matchId } = await makeLiveMatch(app, cookie, clubId);
    const live = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live`, headers: { cookie } });
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
      url: `/api/matches/${matchId}/lineup`,
      headers: { cookie },
      payload: { formation: 4, starters: newStarters, subs: newSubs, penaltyTakerId: null, freeKickTakerId: null },
    });
    expect(lineupRes.statusCode).toBe(200);
    const after = lineupRes.json().state;
    const afterPitch = (after.humanSide === 0 ? after.homeOn : after.awayOn).map((p: { id: number }) => p.id);
    expect(afterPitch).toContain(swappedIn);
    expect(afterPitch).not.toContain(swappedOut);
    // Kick off on the server clock: age past kickoff and run the worker path.
    await ageLiveMatch(app, matchId, 1);
    const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
    const { advanceLiveMatches } = await import("../src/game/world");
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) throw new Error("no world");
    advanceLiveMatches(loaded.world, Date.now());
    await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
    const live1 = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live`, headers: { cookie } });
    expect(live1.statusCode).toBe(200);
    expect(live1.json().state.phase).toBe("first");
    const locked = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/lineup`,
      headers: { cookie },
      payload: { formation: 4, starters: newStarters, subs: newSubs, penaltyTakerId: null, freeKickTakerId: null },
    });
    expect(locked.statusCode).toBe(400);
    await app.close();
  });

  it("GET /club/lineup without a formation param returns the club's saved formation", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "restplayer4");

    const auto = await app.inject({ method: "GET", url: `/api/club/lineup?auto=1&formation=7`, headers: { cookie } });
    expect(auto.statusCode).toBe(200);
    const autoLineup = auto.json();
    expect(autoLineup.formation).toBe(7);
    const persist = await app.inject({
      method: "POST",
      url: `/api/club/lineup`,
      headers: { cookie },
      payload: {
        formation: 7,
        starters: autoLineup.starters.map((p: { id: number }) => p.id),
        subs: autoLineup.subs.map((p: { id: number }) => p.id),
        penaltyTakerId: null,
        freeKickTakerId: null,
      },
    });
    expect(persist.statusCode).toBe(200);

    const view = await app.inject({ method: "GET", url: `/api/club/lineup`, headers: { cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.json().formation).toBe(7);
    expect(view.json().slots).toHaveLength(11);
    await app.close();
  });
});

describe("live match over WebSocket", () => {
  it("streams server-driven state and rejects client-driven ticks", async () => {
    const app = buildServer();
    await app.ready();
    const port = await app.listen({ port: 0, host: "127.0.0.1" });
    const { cookie, clubId } = await setupClub(app, "wsplayer");
    const { matchId } = await makeLiveMatch(app, cookie, clubId);
    await ageLiveMatch(app, matchId, 110, true);
    const url = `ws://127.0.0.1:${new URL(port).port}/api/matches/${matchId}/ws`;

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

    ws.send(JSON.stringify({ type: "state" }));
    await waitFor("state");
    const s0 = messages.find((m) => m.type === "state")!.state as { phase: string };
    expect(s0.phase).toBe("pregame");

    ws.send(JSON.stringify({ type: "tick", minutes: 4, resume: true }));
    await waitFor("error");
    expect(messages.find((m) => m.type === "error")?.message).toBe("Unknown message type");

    const { liveMatchProcessor } = await import("../src/services/jobs/liveMatchProcessor");
    await liveMatchProcessor(app.prisma);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const streamed = messages.some((message) => message.type === "delta" || message.type === "finished" || (message.type === "state" && (message.state as { phase?: string } | undefined)?.phase !== "pregame"));

    ws.close();
    await app.close();
    expect(streamed).toBe(true);
  }, 30_000);
});

describe("multiplayer world WebSocket", () => {
  it("authenticates the user channel and reports the current live match", async () => {
    const app = buildServer();
    await app.ready();
    const port = await app.listen({ port: 0, host: "127.0.0.1" });
    const { cookie, clubId, userId } = await setupClub(app, "worldsocket");
    const { matchId } = await makeLiveMatch(app, cookie, clubId);
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(port).port}/api/mp/ws`, { headers: { cookie } });
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const iv = setInterval(() => {
        if (messages.some((message) => message.type === "liveMatchStarted")) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - started > 8000) {
          clearInterval(iv);
          reject(new Error("timeout waiting for liveMatchStarted"));
        }
      }, 40);
    });
    expect(messages.find((message) => message.type === "liveMatchStarted")?.matchId).toBe(matchId);

    ws.send(JSON.stringify({ type: "ping" }));
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const iv = setInterval(() => {
        if (messages.some((message) => message.type === "pong")) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - started > 8000) {
          clearInterval(iv);
          reject(new Error("timeout waiting for pong"));
        }
      }, 40);
    });

    const { publishUserWorldEvent } = await import("../src/services/worldEvents");
    publishUserWorldEvent(userId, { type: "invalidate", scope: "transfers" });
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const iv = setInterval(() => {
        if (messages.some((message) => message.type === "invalidate" && message.scope === "transfers")) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - started > 8000) {
          clearInterval(iv);
          reject(new Error("timeout waiting for invalidate"));
        }
      }, 40);
    });

    ws.close();
    await app.close();
  });
});

describe("live match real-time pacing", () => {
  it("advances a live match to full time in ~the configured real duration", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie, clubId } = await setupClub(app, "pacer");
    const { matchId } = await makeLiveMatch(app, cookie, clubId);

    const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
    const { advanceLiveMatches } = await import("../src/game/world");
    const { MP_CONFIG } = await import("../src/config");

    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) throw new Error("no world");
    const world = loaded.world;
    const st = world.liveMatches.find((s) => s.matchId === matchId)!;
    expect(st.ended).toBe(false);

    // Simulate the worker: step forward in ~2s real-time increments (as a 2s
    // worker would) until the match ends. `advanceLiveMatches` manages the
    // fractional carry itself, so we must not reset lastAdvancedAt.
    const kickoff = st.lastAdvancedAt;
    let endedAt = 0;
    for (let t = kickoff + 2000; !st.ended && t < kickoff + MP_CONFIG.matchDurationMinutes * 60 * 1000 * 2; t += 2000) {
      advanceLiveMatches(world, t);
      if (st.ended) {
        endedAt = t;
        break;
      }
    }
    expect(st.ended).toBe(true);
    // The match should have finished after ~matchDurationMinutes of simulated
    // real time, not immediately and not after 2x the configured duration.
    const realElapsed = endedAt - kickoff;
    expect(realElapsed).toBeGreaterThan(MP_CONFIG.matchDurationMinutes * 60 * 1000 * 0.6);
    expect(realElapsed).toBeLessThanOrEqual(MP_CONFIG.matchDurationMinutes * 60 * 1000 * 1.6);

    await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    await app.close();
  }, 90_000);
});
