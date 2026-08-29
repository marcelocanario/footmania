import { describe, expect, it } from "vitest";
import {
  assignNaturalPositions,
  assertNumericNeutrality,
  buildMigrationPlan,
  groupSeed,
  migrateSavedLineup,
  splitGroup,
  type LegacyCode,
  type MigrationClub,
  type MigrationPlayer,
} from "../src/services/naturalPositionMigration";
import { legacyPositionGroup, positionGroup } from "../src/game/positions";
import { overallFromSkills } from "../src/game/rating";
import { formationById } from "../src/game/formations";
import { isEligible } from "../src/game/outOfPosition";
import { createRng, nextInt } from "../src/game/rng";
import type { SkillSet } from "../src/game/types";

const SEED = 987_654;

function skills(rng: ReturnType<typeof createRng>): SkillSet {
  return {
    gol: 1 + nextInt(rng, 100), pace: 1 + nextInt(rng, 100), tec: 1 + nextInt(rng, 100),
    pas: 1 + nextInt(rng, 100), des: 1 + nextInt(rng, 100), playmaking: 1 + nextInt(rng, 100),
    fin: 1 + nextInt(rng, 100),
  };
}

function legacyPlayer(id: number, legacy: LegacyCode, overrides: Partial<MigrationPlayer> = {}): MigrationPlayer {
  const s = overrides.skills ?? skills(createRng(id * 7919 + 13));
  // Stored OVR is the LEGACY value: the pre-change formula is the broad-group
  // formula, so it must survive the split unchanged.
  const legacyOverall = overallFromSkills(
    ({ 0: "GK", 1: "LB", 2: "CB", 3: "DM", 4: "ST" } as const)[legacy],
    s,
  );
  // `skills` is fixed by the caller's override (if any) and already folded into
  // `legacyOverall`, so it is spread first and never overwritten again.
  return {
    id, clubId: 1, isYouth: false, legacy, overall: legacyOverall,
    injuryDays: 0, suspendedGames: 0, onSale: false,
    ...overrides,
    skills: s,
  };
}

/** A roster with the given legacy-code counts, all at one club. */
function roster(counts: Partial<Record<LegacyCode, number>>, clubId = 1, isYouth = false): MigrationPlayer[] {
  const out: MigrationPlayer[] = [];
  let id = 1;
  for (const [code, n] of Object.entries(counts)) {
    for (let i = 0; i < (n ?? 0); i++) {
      out.push(legacyPlayer(id++, Number(code) as LegacyCode, { clubId, isYouth }));
    }
  }
  return out;
}

describe("natural-position migration: assignment", () => {
  it("keeps every player inside his legacy broad group", () => {
    const players = roster({ 0: 3, 1: 4, 2: 5, 3: 10, 4: 8 });
    const assigned = assignNaturalPositions(players, SEED, new Map());
    expect(assigned.size).toBe(players.length);
    for (const p of players) {
      expect(positionGroup(assigned.get(p.id)!)).toBe(legacyPositionGroup(p.legacy));
    }
  });

  it("preserves OVR exactly for every player (§14.5)", () => {
    const players = roster({ 0: 3, 1: 4, 2: 5, 3: 10, 4: 8 });
    const assigned = assignNaturalPositions(players, SEED, new Map());
    expect(() => assertNumericNeutrality(players, assigned)).not.toThrow();
    for (const p of players) {
      expect(overallFromSkills(assigned.get(p.id)!, p.skills)).toBe(p.overall);
    }
  });

  it("aborts rather than repairing when a stored OVR would move", () => {
    const players = roster({ 3: 4 });
    players[0].overall += 1;
    const assigned = assignNaturalPositions(players, SEED, new Map());
    expect(() => assertNumericNeutrality(players, assigned)).toThrow(/OVR mismatch/);
    // The stored value is untouched by the check.
    expect(players[0].overall).toBe(legacyPlayer(players[0].id, 3).overall + 1);
  });

  it("rejects a corrupt legacy position code without producing a plan", () => {
    const players = roster({ 2: 2 });
    (players[0] as { legacy: number }).legacy = 7;
    expect(() => buildMigrationPlan(players, [], SEED, new Map())).toThrow(/invalid legacy position/);
  });

  it("is deterministic: the same rows and seed give the same assignment", () => {
    const a = assignNaturalPositions(roster({ 1: 4, 3: 10, 4: 8 }), SEED, new Map());
    const b = assignNaturalPositions(roster({ 1: 4, 3: 10, 4: 8 }), SEED, new Map());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it("splits even and odd FB and MF counts exactly", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 7, 8]) {
      const fb = splitGroup("FB", roster({ 1: n }), SEED, "senior", "1", "senior");
      expect(fb.size).toBe(n);
      const lb = [...fb.values()].filter((p) => p === "LB").length;
      const rb = [...fb.values()].filter((p) => p === "RB").length;
      expect(lb + rb).toBe(n);
      expect(Math.abs(lb - rb)).toBeLessThanOrEqual(1);

      const mf = splitGroup("MF", roster({ 3: n }), SEED, "senior", "1", "senior");
      const dm = [...mf.values()].filter((p) => p === "DM").length;
      const am = [...mf.values()].filter((p) => p === "AM").length;
      expect(dm + am).toBe(n);
      expect(Math.abs(dm - am)).toBeLessThanOrEqual(1);
    }
  });

  it("splits 1, 2 and 7 forwards into configured LW/RW/ST shares", () => {
    const within = { LW: 2 / 7, RW: 2 / 7, ST: 3 / 7 };
    for (const n of [1, 2, 7]) {
      const fw = splitGroup("FW", roster({ 4: n }), SEED, "senior", "1", "senior");
      expect(fw.size).toBe(n);
      const counts = { LW: 0, RW: 0, ST: 0 } as Record<string, number>;
      for (const pos of fw.values()) counts[pos]++;
      expect(counts.LW + counts.RW + counts.ST).toBe(n);
      for (const [role, weight] of Object.entries(within)) {
        const exact = weight * n;
        expect(counts[role]).toBeGreaterThanOrEqual(Math.floor(exact));
        expect(counts[role]).toBeLessThanOrEqual(Math.ceil(exact));
      }
    }
    // The configured FW mix is ST-heavy; a hard-coded 1/3 split would not be.
    const seven = splitGroup("FW", roster({ 4: 7 }), SEED, "senior", "1", "senior");
    expect([...seven.values()].filter((p) => p === "ST").length).toBe(3);
  });

  it("maps GK and CB one-to-one", () => {
    for (const [legacy, expected] of [[0, "GK"], [2, "CB"]] as const) {
      const split = splitGroup(legacyPositionGroup(legacy), roster({ [legacy]: 5 }), SEED, "senior", "1", "senior");
      expect([...split.values()]).toEqual(Array(5).fill(expected));
    }
  });

  it("groups a loaned player with his lender, not the borrower", () => {
    const lender = roster({ 1: 3 }, 10);
    const loanedOut = legacyPlayer(99, 1, { clubId: 20 });
    const all = [...lender, loanedOut];
    // Grouped with the lender (club 10), the four FBs split 2/2.
    const withLoan = assignNaturalPositions(all, SEED, new Map([[99, 10]]));
    const lenderGroup = [...withLoan.entries()].filter(([id]) => id === 99 || lender.some((p) => p.id === id));
    const lb = lenderGroup.filter(([, pos]) => pos === "LB").length;
    expect(lb + lenderGroup.filter(([, pos]) => pos === "RB").length).toBe(4);
    expect(Math.abs(lb - 2)).toBeLessThanOrEqual(1);
    // Without the loan mapping the borrower forms a group of one, giving a
    // different assignment — proving the lender grouping actually applies.
    const withoutLoan = assignNaturalPositions(all, SEED, new Map());
    expect(withoutLoan.size).toBe(4);
    expect([...withLoan.entries()].sort()).not.toEqual([...withoutLoan.entries()].sort());
  });

  it("keeps senior and youth free agents in separate stock groups", () => {
    const seniorFas = roster({ 1: 3 }, 1).map((p) => ({ ...p, clubId: null }));
    const youthFas = roster({ 1: 3 }, 1, true).map((p, i) => ({ ...p, id: p.id + 100, clubId: null, isYouth: true }));
    const assigned = assignNaturalPositions([...seniorFas, ...youthFas], SEED, new Map());
    expect(assigned.size).toBe(6);
    // Each group of three splits 2/1 or 1/2 on its own, so each has both roles.
    for (const group of [seniorFas, youthFas]) {
      const roles = new Set(group.map((p) => assigned.get(p.id)));
      expect(roles).toEqual(new Set(["LB", "RB"]));
    }
  });

  it("handles filler and dormant clubs exactly like active ones", () => {
    const active = roster({ 3: 6 }, 1);
    const dormant = roster({ 3: 6 }, 2).map((p) => ({ ...p, id: p.id + 50 }));
    const assigned = assignNaturalPositions([...active, ...dormant], SEED, new Map());
    for (const group of [active, dormant]) {
      const counts = group.map((p) => assigned.get(p.id)!);
      expect(counts.filter((r) => r === "DM")).toHaveLength(3);
      expect(counts.filter((r) => r === "AM")).toHaveLength(3);
    }
  });

  it("uses the exact §14.2 group seed key", () => {
    expect(groupSeed(42, "senior", "7", "senior", "MF")).toBe("42|position-v2-migration|senior|7|senior|MF");
  });
});

describe("natural-position migration: saved lineups", () => {
  const squad = (): MigrationPlayer[] => [
    legacyPlayer(1, 0), legacyPlayer(2, 0),
    legacyPlayer(3, 1), legacyPlayer(4, 1),
    legacyPlayer(5, 2), legacyPlayer(6, 2),
    legacyPlayer(7, 3), legacyPlayer(8, 3), legacyPlayer(9, 3),
    legacyPlayer(10, 4), legacyPlayer(11, 4), legacyPlayer(12, 4),
    legacyPlayer(13, 3), legacyPlayer(14, 2),
  ];

  function context(players: MigrationPlayer[]) {
    const positions = assignNaturalPositions(players, SEED, new Map());
    return { byId: new Map(players.map((p) => [p.id, p])), positions };
  }

  it("re-slots the same eleven into legal, ordered slots for the club's formation", () => {
    const players = squad();
    const { byId, positions } = context(players);
    const starters = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const saved = JSON.stringify({ starters, subs: [2, 13, 14], freeKickTakerId: 10 });
    const result = migrateSavedLineup(saved, 4, 1, byId, positions)!;
    expect(result).not.toBeNull();
    expect(new Set(result.starters)).toEqual(new Set(starters));
    // Every rewritten slot is a legal pairing, and slot 0 holds the goalkeeper.
    const slots = formationById(4)!.slots;
    result.starters.forEach((id, index) => {
      expect(isEligible(positions.get(id)!, slots[index].role), `${id} at ${slots[index].role}`).toBe(true);
    });
    expect(positions.get(result.starters[0])).toBe("GK");
    expect(result.freeKickTakerId).toBe(10);
  });

  it("preserves bench order and drops entries promoted into the XI", () => {
    const players = squad();
    const { byId, positions } = context(players);
    const saved = JSON.stringify({ starters: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], subs: [14, 2, 13, 10], freeKickTakerId: null });
    const result = migrateSavedLineup(saved, 4, 1, byId, positions)!;
    // 10 is in the XI, so it is dropped; the rest keep their saved order.
    expect(result.subs).toEqual([14, 2, 13]);
  });

  it("drops the lineup when the saved set is short, duplicated or unavailable", () => {
    const players = squad();
    const { byId, positions } = context(players);
    const full = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(migrateSavedLineup(JSON.stringify({ starters: full.slice(0, 10), subs: [] }), 4, 1, byId, positions)).toBeNull();
    expect(migrateSavedLineup(JSON.stringify({ starters: [...full.slice(0, 10), 3], subs: [] }), 4, 1, byId, positions)).toBeNull();
    expect(migrateSavedLineup("not json", 4, 1, byId, positions)).toBeNull();
    // An injured starter makes the set incomplete rather than being carried over.
    byId.get(7)!.injuryDays = 5;
    expect(migrateSavedLineup(JSON.stringify({ starters: full, subs: [] }), 4, 1, byId, positions)).toBeNull();
  });

  it("refuses an unknown formation instead of silently rewriting for another", () => {
    const players = squad();
    const { byId, positions } = context(players);
    const saved = JSON.stringify({ starters: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], subs: [] });
    expect(migrateSavedLineup(saved, 99, 1, byId, positions)).toBeNull();
  });

  it("nulls a penalty taker who is no longer a starter and keeps one who is", () => {
    const players = squad();
    const starters = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const savedJson = JSON.stringify({ starters, subs: [2, 13, 14], freeKickTakerId: null });
    const clubs: MigrationClub[] = [
      { id: 1, savedLineupJson: savedJson, tacticsFormation: 4, penaltyTakerId: 10 },
      { id: 2, savedLineupJson: savedJson, tacticsFormation: 4, penaltyTakerId: 13 },
    ];
    const plan = buildMigrationPlan(players, clubs, SEED, new Map());
    const [keeps, drops] = plan.lineupUpdates;
    expect(keeps.penaltyTakerId).toBe(10);
    // Club 2's saved lineup belongs to club 1's players, so it is dropped and
    // its taker cleared — never left dangling.
    expect(drops.penaltyTakerId).toBeNull();
    expect(drops.json).toBeNull();
  });

  it("produces no lineup update for a club with no saved lineup", () => {
    const plan = buildMigrationPlan(squad(), [{ id: 1, savedLineupJson: null, tacticsFormation: 4, penaltyTakerId: null }], SEED, new Map());
    expect(plan.lineupUpdates).toHaveLength(0);
  });
});

describe("natural-position migration: plan", () => {
  it("reports natural-role counts that sum to the roster", () => {
    const players = roster({ 0: 3, 1: 4, 2: 5, 3: 10, 4: 8 });
    const plan = buildMigrationPlan(players, [], SEED, new Map());
    const total = Object.values(plan.countsByRole).reduce((a, b) => a + b, 0);
    expect(total).toBe(30);
    expect(plan.countsByRole.GK).toBe(3);
    expect(plan.countsByRole.CB).toBe(5);
    expect(plan.countsByRole.LB + plan.countsByRole.RB).toBe(4);
    expect(plan.countsByRole.DM + plan.countsByRole.AM).toBe(10);
    expect((plan.countsByRole.LW ?? 0) + (plan.countsByRole.RW ?? 0) + (plan.countsByRole.ST ?? 0)).toBe(8);
  });

  it("is idempotent in effect: re-running on the plan's output is a no-op shape", () => {
    const players = roster({ 1: 4, 3: 10, 4: 8 });
    const first = buildMigrationPlan(players, [], SEED, new Map());
    const second = buildMigrationPlan(players, [], SEED, new Map());
    expect([...first.positionByPlayer.entries()].sort()).toEqual([...second.positionByPlayer.entries()].sort());
  });
});
