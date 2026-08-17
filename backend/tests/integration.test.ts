import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test.db";
process.env.NODE_ENV = "test";

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
    const saveId = created.id;

    const start = await app.inject({
      method: "POST",
      url: `/api/saves/${saveId}/start`,
      headers: { cookie },
      payload: { country: "BRA" },
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
    expect(state1.json().snapshot.competitions.length).toBe(1);

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

  it("resolves a human auction listing end-to-end", async () => {
    const app = buildServer();
    await app.ready();

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "auctioneer", password: "secret123" },
    });
    expect(register.statusCode).toBe(200);
    const cookie = (register.headers["set-cookie"] as string).split(";")[0];

    const create = await app.inject({
      method: "POST",
      url: "/api/saves",
      headers: { cookie },
      payload: { name: "Auction Career", seed: 4321 },
    });
    const saveId = create.json().id;
    const start = await app.inject({
      method: "POST",
      url: `/api/saves/${saveId}/start`,
      headers: { cookie },
      payload: { country: "BRA" },
    });
    expect(start.statusCode).toBe(200);

    const state0 = await app.inject({ method: "GET", url: `/api/saves/${saveId}/state`, headers: { cookie } });
    const squad = state0.json().snapshot.squad as { id: number; name: string }[];
    const target = squad.find((p) => !p.name.includes("(Y)")) ?? squad[0];
    const cashBefore = state0.json().snapshot.club.cash as number;
    const startClubId = state0.json().snapshot.club.id as number;

    const sell = await app.inject({
      method: "POST",
      url: `/api/transfers/sell?saveId=${saveId}`,
      headers: { cookie },
      payload: { playerId: target.id, mode: "auction" },
    });
    expect(sell.statusCode).toBe(200);
    const listingId = sell.json().listingId as number;

    const selfBid = await app.inject({
      method: "POST",
      url: `/api/auctions/${listingId}/bid?saveId=${saveId}`,
      headers: { cookie },
      payload: { amount: 1 },
    });
    expect(selfBid.statusCode).toBe(400);

    let moved = false;
    for (let i = 0; i < 12 && !moved; i++) {
      const adv = await app.inject({ method: "POST", url: `/api/saves/${saveId}/advance`, headers: { cookie } });
      expect(adv.statusCode).toBe(200);
      const day = adv.json();
      if (day.matchPending) {
        const finish = await app.inject({
          method: "POST",
          url: `/api/matches/${day.humanMatch.id}/finish?saveId=${saveId}`,
          headers: { cookie },
        });
        expect(finish.statusCode).toBe(200);
      }
      const st = await app.inject({ method: "GET", url: `/api/saves/${saveId}/state`, headers: { cookie } });
      const nowSquad = st.json().snapshot.squad as { id: number }[];
      if (!nowSquad.some((p) => p.id === target.id)) moved = true;
    }
    expect(moved).toBe(true);

    const final = await app.inject({ method: "GET", url: `/api/saves/${saveId}/state`, headers: { cookie } });
    const snap = final.json().snapshot;
    expect(snap.auctions.find((a: { id: number }) => a.id === listingId)).toBeUndefined();
    expect(snap.news.some((n: { kind: string; text: string }) => n.kind === "auction" && n.text.includes(target.name))).toBe(true);
    expect(snap.club.cash).toBeGreaterThan(cashBefore);

    const finances = await app.inject({ method: "GET", url: `/api/club/finances?saveId=${saveId}`, headers: { cookie } });
    const fees = finances.json().income.filter((e: { code: number; label: string }) => e.code === 3 && e.label.includes(target.name));
    expect(fees).toHaveLength(1);
    expect(fees[0].amount).toBeGreaterThan(0);

    let aiAuction: { id: number; minBid: number; currentBid: number; sellerClubId: number | null } | null = null;
    for (let i = 0; i < 12 && !aiAuction; i++) {
      const adv = await app.inject({ method: "POST", url: `/api/saves/${saveId}/advance`, headers: { cookie } });
      const day = adv.json();
      if (day.matchPending) {
        await app.inject({
          method: "POST",
          url: `/api/matches/${day.humanMatch.id}/finish?saveId=${saveId}`,
          headers: { cookie },
        });
      }
      const auctions = await app.inject({ method: "GET", url: `/api/transfers/auctions?saveId=${saveId}`, headers: { cookie } });
      const list = auctions.json().auctions as { id: number; minBid: number; currentBid: number; sellerClubId: number | null }[];
      aiAuction = list.find((a) => a.sellerClubId !== startClubId) ?? null;
    }
    expect(aiAuction).not.toBeNull();

    const lowBid = await app.inject({
      method: "POST",
      url: `/api/auctions/${aiAuction!.id}/bid?saveId=${saveId}`,
      headers: { cookie },
      payload: { amount: Math.max(1, aiAuction!.minBid - 1) },
    });
    expect(lowBid.statusCode).toBe(400);

    const validBid = await app.inject({
      method: "POST",
      url: `/api/auctions/${aiAuction!.id}/bid?saveId=${saveId}`,
      headers: { cookie },
      payload: { amount: Math.max(aiAuction!.minBid, aiAuction!.currentBid + 1000) },
    });
    expect(validBid.statusCode).toBe(200);
    expect(validBid.json().currentBid).toBeGreaterThan(0);

    await app.close();
  });
});
