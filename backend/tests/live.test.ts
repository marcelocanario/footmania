import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import type { FastifyInstance } from "fastify";
import { createTestSessionCookie } from "./testAuth";

async function setupClub(app: FastifyInstance, username: string, seed = 4242) {
  void seed;
  const { cookie, userId } = await createTestSessionCookie(app, { name: username, email: `${username}@test.dev` });
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
  return { cookie, clubId: body.clubId as number, userId };
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
    // §9.5 makes goalkeeping slots exclusive, so an outfield swap must name an
    // outfield bench player explicitly — the bench is archetype-ordered and
    // starts with the reserve keeper.
    const benchOutfielder = bench.find((p: { naturalPosition: string }) => p.naturalPosition !== "GK");
    const pitchOutfielder = onPitch.find((p: { deployedRole: string | null }) => p.deployedRole !== "GK");
    expect(benchOutfielder).toBeDefined();
    expect(pitchOutfielder).toBeDefined();
    const bad = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/sub`,
      headers: { cookie },
      payload: { outId: benchOutfielder.id, inId: onPitch[0].id },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/sub`,
      headers: { cookie },
      payload: { outId: pitchOutfielder.id, inId: benchOutfielder.id },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().state.usedSubs[s.humanSide]).toBe(1);
    await app.close();
  });

  it("allows live style changes but rejects formation changes through the tactics endpoint", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie, clubId } = await setupClub(app, "resttactics");
    const { matchId } = await makeLiveMatch(app, cookie, clubId);

    const live = await app.inject({ method: "GET", url: `/api/matches/${matchId}/live`, headers: { cookie } });
    const before = live.json().state as { humanSide: 0 | 1; homeTactics: { style: number }; awayTactics: { style: number } };
    const update = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/tactics`,
      headers: { cookie },
      payload: { style: 1, pressing: 2, direction: 1 },
    });
    expect(update.statusCode).toBe(200);
    const updated = update.json().state;
    const tactics = updated[before.humanSide === 0 ? "homeTactics" : "awayTactics"];
    expect(tactics).toMatchObject({ style: 1, pressing: 2, direction: 1 });

    const formation = await app.inject({
      method: "POST",
      url: `/api/matches/${matchId}/tactics`,
      headers: { cookie },
      payload: { formation: 7, style: 1 },
    });
    expect(formation.statusCode).toBe(400);
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
    // Slot 1 of a 4-4-2 is LB, so the incoming player must be an outfielder:
    // §9.3 rejects a natural goalkeeper anywhere but slot 0.
    const benchIndex = bench.findIndex((p: { naturalPosition: string }) => p.naturalPosition !== "GK");
    expect(benchIndex).toBeGreaterThanOrEqual(0);
    const swappedOut = starters[1];
    const swappedIn = subs[benchIndex];
    const newStarters = starters.slice();
    newStarters[1] = swappedIn;
    const newSubs = subs.slice();
    newSubs[benchIndex] = swappedOut;
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

  it("saves lineups with a high catalog formation id (3-3-2-2 = 16) through /club/lineup", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "restplayer5");
    const { FORMATIONS } = await import("../src/game/formations");
    const highId = FORMATIONS.find((f) => f.name === "3-3-2-2")!.id;
    expect(highId).toBeGreaterThan(12); // guard: regression only bites ids past the old fixed cap

    const auto = await app.inject({ method: "GET", url: `/api/club/lineup?auto=1&formation=${highId}`, headers: { cookie } });
    expect(auto.statusCode).toBe(200);
    const autoLineup = auto.json();
    expect(autoLineup.formation).toBe(highId);
    expect(autoLineup.slots).toHaveLength(11);
    const persist = await app.inject({
      method: "POST",
      url: `/api/club/lineup`,
      headers: { cookie },
      payload: {
        formation: highId,
        starters: autoLineup.starters.map((p: { id: number }) => p.id),
        subs: autoLineup.subs.map((p: { id: number }) => p.id),
        penaltyTakerId: null,
        freeKickTakerId: null,
      },
    });
    expect(persist.statusCode).toBe(200);
    expect(persist.json().ok).toBe(true);

    const view = await app.inject({ method: "GET", url: `/api/club/lineup`, headers: { cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.json().formation).toBe(highId);
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

describe("live player card stats", () => {
  it("reflects a goal scored mid-match on the player history card before full time", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie, clubId } = await setupClub(app, "cardlive");
    const { matchId } = await makeLiveMatch(app, cookie, clubId);

    const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
    const { EVENT_CODES, GOAL_SUBTYPES } = await import("../src/game/constants");
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) throw new Error("no world");
    const world = loaded.world;
    const st = world.liveMatches.find((s) => s.matchId === matchId)!;
    const humanSide = st.homeClubId === clubId ? 0 : 1;
    const on = humanSide === 0 ? st.homeOn : st.awayOn;
    const scorerId = on[0];
    const assisterId = on[1];

    // Inject the goal the engine would have recorded this tick.
    st.scores[humanSide] = 1;
    st.events.push({
      minute: 12,
      half: 1,
      type: EVENT_CODES.GOAL,
      subtype: GOAL_SUBTYPES.NORMAL,
      clubId: clubId,
      playerId: scorerId,
      player2Id: assisterId,
      goalType: GOAL_SUBTYPES.NORMAL,
    });
    await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);

    const card = await app.inject({ method: "GET", url: `/api/players/${scorerId}/history`, headers: { cookie } });
    expect(card.statusCode).toBe(200);
    expect(card.json().player.seasonGoals).toBe(1);
    expect(card.json().player.careerGoals).toBe(1);

    const assister = await app.inject({ method: "GET", url: `/api/players/${assisterId}/history`, headers: { cookie } });
    expect(assister.statusCode).toBe(200);
    expect(assister.json().player.seasonAssists).toBe(1);
    expect(assister.json().player.careerAssists).toBe(1);

    await app.close();
  });
});
