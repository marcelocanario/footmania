process.env.NODE_ENV = "test";
import { buildServer } from "../src/server";

async function main() {
  const app = buildServer();
  await app.ready();
  const port = await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${new URL(port).port}`;
  const cookieJar = new Map<string, string>();
  const username = `smoke${Date.now()}`;

  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(base + url, {
      method,
      headers: {
        Connection: "close",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookieJar.get("cookie") ? { Cookie: cookieJar.get("cookie")! } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookieJar.set("cookie", setCookie.split(";")[0]);
    return { status: res.status, body: await res.json() };
  }

  const reg = await call("POST", "/api/auth/register", { username, password: "secret123" });
  console.log("register:", reg.status);

  const created = await call("POST", "/api/saves", { name: "Smoke Career", seed: 20260815 });
  console.log("create save:", created.status, "id:", created.body.id);

  const state0 = await call("GET", `/api/saves/${created.body.id}/state`);
  console.log("state not started:", state0.status, "featured:", state0.body.featuredCountries.length, "all:", state0.body.allCountries.length);
  const featured = state0.body.featuredCountries as { code: string; name: string }[];
  const nonBra = featured.find((c) => c.code !== "BRA")!;
  console.log("choosing country:", nonBra.code, nonBra.name);

  const started = await call("POST", `/api/saves/${created.body.id}/start`, { country: nonBra.code });
  console.log("start:", started.status, "clubId:", started.body.clubId);

  const state1 = await call("GET", `/api/saves/${created.body.id}/state`);
  const snap = state1.body.snapshot;
  const club = snap.club;
  console.log("club:", club.name, "country:", club.country, "coach:", club.coachName);
  console.log("squad sample:", snap.squad.slice(0, 3).map((p: { name: string }) => p.name).join(" | "));
  console.log("youth sample:", snap.juniors.slice(0, 2).map((p: { name: string }) => p.name).join(" | "));
  console.log("competitions:", snap.competitions.length, snap.competitions[0]?.name, "position:", snap.competitions[0]?.position);

  let advances = 0;
  let matchPending = false;
  while (advances < 40) {
    const adv = await call("POST", `/api/saves/${created.body.id}/advance`);
    advances++;
    if (adv.status !== 200) {
      console.log("advance error at", advances, "status", adv.status, JSON.stringify(adv.body));
      break;
    }
    if (advances % 10 === 0) console.log("advance", advances, "day", adv.body.dayIndex, "pending", adv.body.matchPending);
    if (adv.body.seasonEnded) {
      console.log("SEASON ENDED after", advances, "advances");
      const fin = await call("GET", `/api/saves/${created.body.id}/state`);
      console.log("summary:", JSON.stringify(fin.body.snapshot.seasonSummary));
      console.log("year now:", fin.body.snapshot.save.year);
      break;
    }
    if (adv.body.matchPending) {
      matchPending = true;
      const fin = await call("POST", `/api/matches/${adv.body.humanMatch.id}/finish?saveId=${created.body.id}`);
      if (fin.body.dayResult?.seasonEnded) {
        console.log("SEASON ENDED at finalize after", advances, "advances");
        const fin2 = await call("GET", `/api/saves/${created.body.id}/state`);
        console.log("summary:", JSON.stringify(fin2.body.snapshot.seasonSummary));
        console.log("year now:", fin2.body.snapshot.save.year);
        break;
      }
    }
  }
  console.log("advances total:", advances, "matchPending seen:", matchPending);

  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});