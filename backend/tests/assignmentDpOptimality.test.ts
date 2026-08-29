import { describe, it, expect } from "vitest";
import { assignBestXI, assignOnPitchToSlots } from "../src/game/club";
import { formationById } from "../src/game/formations";
import type { DeployedRole } from "../src/game/positions";

function trueOptimum(n: number, score: (pi: number, slot: number) => number, requireFull: boolean): number {
  const full = (1 << 11) - 1;
  let cur = new Float64Array(1 << 11).fill(-Infinity);
  cur[0] = 0;
  for (let pi = 0; pi < n; pi++) {
    const next = Float64Array.from(cur);
    for (let mask = 0; mask <= full; mask++) {
      if (cur[mask] === -Infinity) continue;
      for (let slot = 0; slot < 11; slot++) {
        if (mask & (1 << slot)) continue;
        const s = score(pi, slot);
        if (s === -Infinity) continue;
        const nm = mask | (1 << slot);
        if (cur[mask] + s > next[nm]) next[nm] = cur[mask] + s;
      }
    }
    cur = next;
  }
  if (requireFull) return cur[full];
  let bestCount = -1, best = -Infinity;
  for (let mask = 0; mask <= full; mask++) {
    if (cur[mask] === -Infinity) continue;
    let c = 0; for (let i = 0; i < 11; i++) if (mask & (1 << i)) c++;
    if (c > bestCount || (c === bestCount && cur[mask] > best)) { bestCount = c; best = cur[mask]; }
  }
  return best;
}

/**
 * §9.2 requires a GLOBAL optimum. The DP is easy to get subtly wrong — keying
 * the state on the slot mask alone and filtering against one stored player set
 * looks equivalent but is not provably optimal — so this compares it against an
 * independent reference `(playerIndex, mask)` DP over randomized score matrices.
 */
describe("assignment DP optimality", () => {
  it("matches an independent reference DP over randomized score matrices", () => {
    let badFull = 0, badPartial = 0, tested = 0;
    for (const fid of [0, 4, 5, 7, 11, 12]) {
      const roles = formationById(fid)!.slots.map((s) => s.role);
      const uniq = [...new Set(roles)];
      let seed = fid * 7919 + 13;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let t = 0; t < 400; t++) {
        const n = 9 + Math.floor(rnd() * 6);
        const players = Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
        const tbl = players.map(() => uniq.map(() => (rnd() < 0.45 ? -Infinity : Math.round(rnd() * 50))));
        const scoreOf = (p: { id: number }, role: DeployedRole) => {
          const v = tbl[p.id - 1][uniq.indexOf(role)];
          return v === -Infinity ? null : v;
        };
        const raw = (pi: number, slot: number) => tbl[pi][uniq.indexOf(roles[slot])];
        tested++;
        const gotFull = assignBestXI(players as never, fid, scoreOf as never);
        const wantFull = trueOptimum(n, raw, true);
        if (wantFull === -Infinity) { if (gotFull) badFull++; }
        else if (!gotFull || Math.abs(gotFull.totalScore - wantFull) > 1e-6) badFull++;

        const assign = assignOnPitchToSlots(players, fid, scoreOf) as (number | null)[] | null;
        const wantPartial = trueOptimum(n, raw, false);
        const gotScore = (assign ?? []).reduce<number>((sum, id, slot) =>
          id === null ? sum : sum + raw(id - 1, slot), 0);
        const gotCount = (assign ?? []).filter((x) => x !== null).length;
        // Partial must never mis-assign and must reach the reference score at
        // maximum fill.
        if (assign) {
          const ids = assign.filter((x): x is number => x !== null);
          if (new Set(ids).size !== ids.length) badPartial++;
          else if (gotCount > 0 && Math.abs(gotScore - wantPartial) > 1e-6) badPartial++;
        }
      }
    }
    expect(tested).toBeGreaterThan(2000);
    expect(badFull).toBe(0);
    expect(badPartial).toBe(0);
  });
});
