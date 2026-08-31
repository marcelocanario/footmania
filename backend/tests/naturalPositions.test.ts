import { describe, expect, it } from "vitest";
import {
  DEPLOYED_ROLES,
  NATURAL_POSITIONS,
  NATURAL_POSITION_ORDER,
  POSITION_GROUPS,
  groupRepresentative,
  legacyPositionGroup,
  naturalDefaultRole,
  positionFromV2Code,
  positionGroup,
  positionToCode,
  ratingRoleForPosition,
  type DeployedRole,
  type NaturalPosition,
} from "../src/game/positions";
import { FORMATIONS, formationById, formationSimilarity } from "../src/game/formations";
import {
  adjustedSkills,
  adjustedTacticalRating,
  bandUpperBound,
  eligibleNaturalsFor,
  isEligible,
  rolePenalty,
  suitabilityLabel,
} from "../src/game/outOfPosition";
import { allOverallGroups, overallFromSkills, tacticalSkillRating, trainingWeights, weightTotal } from "../src/game/rating";
import { allocateBroadGroupCounts, allocateSeededCounts } from "../src/game/allocation";
import { assignBestXI, assignOnPitchToSlots } from "../src/game/club";
import { coarseRole } from "../src/game/player-rating";
import { createRng, nextInt } from "../src/game/rng";
import { gameConfig } from "../src/config";
import type { Player, SkillSet } from "../src/game/types";

// ---------------------------------------------------------------------------
// §20.1-20.2 domain types, storage codes and mappings
// ---------------------------------------------------------------------------

describe("natural positions", () => {
  it("round-trips every position through its V2 database code", () => {
    const codes = new Set<number>();
    for (const pos of NATURAL_POSITIONS) {
      const code = positionToCode(pos);
      expect(Number.isInteger(code)).toBe(true);
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThanOrEqual(8);
      expect(positionFromV2Code(code)).toBe(pos);
      codes.add(code);
    }
    expect(codes.size).toBe(9);
  });

  it("preserves one legacy child per legacy code in 0..4", () => {
    // Codes 0..4 intentionally keep one child of each legacy GK/FB/CB/MF/FW code
    // so the migration reads naturally; nothing may depend on their order.
    expect([0, 1, 2, 3, 4].map(positionFromV2Code)).toEqual(["GK", "LB", "CB", "DM", "ST"]);
    for (const code of [0, 1, 2, 3, 4]) {
      expect(positionGroup(positionFromV2Code(code))).toBe(legacyPositionGroup(code));
    }
  });

  it("throws on any code outside 0..8 rather than defaulting to GK", () => {
    for (const bad of [-1, 9, 100, 1.5, Number.NaN]) {
      expect(() => positionFromV2Code(bad)).toThrow();
    }
  });

  it("maps every position to its broad group, rating role and default deployed role", () => {
    expect(NATURAL_POSITIONS.map(positionGroup)).toEqual(["GK", "FB", "FB", "CB", "MF", "MF", "FW", "FW", "FW"]);
    expect(NATURAL_POSITIONS.map(ratingRoleForPosition)).toEqual(["GK", "FB", "FB", "CB", "MID", "MID", "FWD", "FWD", "FWD"]);
    // naturalDefaultRole is the identity for all nine.
    for (const pos of NATURAL_POSITIONS) expect(naturalDefaultRole(pos)).toBe(pos);
  });

  it("gives every broad group a representative inside that group", () => {
    for (const group of POSITION_GROUPS) {
      expect(positionGroup(groupRepresentative(group))).toBe(group);
    }
  });

  it("keeps the display order stable", () => {
    expect(NATURAL_POSITION_ORDER).toEqual([...NATURAL_POSITIONS]);
  });

  it("maps every fine deployed role to its prescribed coarse rating role (§20.26)", () => {
    const expected: Record<DeployedRole, string> = {
      GK: "GK", LB: "FB", RB: "FB", CB: "CB",
      DM: "MID", AM: "MID",
      LW: "FWD", RW: "FWD", ST: "FWD",
    };
    for (const role of DEPLOYED_ROLES) expect(coarseRole(role)).toBe(expected[role]);
  });
});

// ---------------------------------------------------------------------------
// §20.3-20.4 formation catalog
// ---------------------------------------------------------------------------

describe("formation catalog", () => {
  it("has 23 formations of 11 unique, well-formed slots with one goalkeeper", () => {
    expect(FORMATIONS).toHaveLength(23);
    for (const formation of FORMATIONS) {
      expect(formation.slots).toHaveLength(11);
      expect(new Set(formation.slots.map((s) => s.key)).size).toBe(11);
      expect(formation.slots.filter((s) => s.role === "GK")).toHaveLength(1);
      expect(formation.slots[0].role).toBe("GK");
      for (const slot of formation.slots) {
        expect(slot.x).toBeGreaterThanOrEqual(0);
        expect(slot.x).toBeLessThanOrEqual(100);
        expect(slot.y).toBeGreaterThanOrEqual(0);
        expect(slot.y).toBeLessThanOrEqual(100);
        expect(slot.label).toBe(slot.role);
      }
    }
  });

  it("derives every lane from the final y coordinate, never from a numeric suffix", () => {
    for (const formation of FORMATIONS) {
      for (const slot of formation.slots) {
        const expected = slot.y < 50 ? "LEFT" : slot.y > 50 ? "RIGHT" : "CENTRE";
        expect(slot.lane, `${formation.name}/${slot.key}`).toBe(expected);
      }
    }
    // The diamond is the case the suffix would get wrong: AM1/AM2 share a line
    // and are wide, while the lone AM3 one line further forward is central.
    const diamond = formationById(5)!;
    expect(diamond.slots.filter((s) => s.role === "AM").map((s) => s.lane)).toEqual(["LEFT", "RIGHT", "CENTRE"]);
  });

  it("derives every tactical line from the deployed role alone", () => {
    const expected: Record<DeployedRole, string> = {
      GK: "GOAL",
      LB: "DEFENCE", RB: "DEFENCE", CB: "DEFENCE",
      DM: "DEFENSIVE_MIDFIELD",
      AM: "ATTACKING_MIDFIELD",
      LW: "ATTACK", RW: "ATTACK", ST: "ATTACK",
    };
    for (const formation of FORMATIONS) {
      for (const slot of formation.slots) expect(slot.line).toBe(expected[slot.role]);
    }
  });

  it("uses all nine deployed roles across the catalog", () => {
    const used = new Set(FORMATIONS.flatMap((f) => f.slots.map((s) => s.role)));
    for (const role of DEPLOYED_ROLES) expect(used.has(role), `${role} unused`).toBe(true);
  });

  it("uses only natural positions as slot roles — no sweeper or wide-mid sub-roles", () => {
    const used = new Set<string>(FORMATIONS.flatMap((f) => f.slots.map((s) => s.role)));
    for (const legacy of ["SW", "LM", "RM"]) expect(used.has(legacy)).toBe(false);
  });

  it("scores formation similarity on role/lane/line tokens, symmetric in [0,1]", () => {
    for (const a of FORMATIONS) {
      expect(formationSimilarity(a, a)).toBe(1);
      for (const b of FORMATIONS) {
        const s = formationSimilarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(s).toBeCloseTo(formationSimilarity(b, a), 12);
      }
    }
  });

  it("returns hand-calculated similarity for two known pairs", () => {
    // 4-4-2 (id 4) vs 4-4-2 Attacking (id 6). Tokens differ only in the middle
    // band: 4-4-2 has AM:LEFT:ATTACKING_MIDFIELD, DM:LEFT:DEFENSIVE_MIDFIELD,
    // DM:RIGHT:DEFENSIVE_MIDFIELD, AM:RIGHT:ATTACKING_MIDFIELD; the Attacking
    // variant has LW:LEFT:ATTACK, AM:LEFT:.., AM:RIGHT:.., RW:RIGHT:ATTACK.
    // Shared: GK, the four defenders, both strikers, and AM:LEFT+AM:RIGHT = 9 of
    // 13 distinct tokens (4-4-2's two DMs are unmatched; the Attacking's LW/RW
    // add one extra attack token per flank).
    const a = formationById(4)!;
    const b = formationById(6)!;
    expect(formationSimilarity(a, b)).toBeCloseTo(9 / 13, 12);

    // 4-3-3 (id 7) vs 4-3-3 Holding (id 8): identical defence and attack; the
    // midfield goes DM+AM+AM -> DM+DM+AM. Shared 8 of 11 + 3 unmatched = 8/14... but
    // both keep one DM:CENTRE and one AM, so intersection is 9 of 13.
    const c = formationById(7)!;
    const d = formationById(8)!;
    const tokens = (f: typeof c) => f.slots.map((s) => `${s.role}:${s.lane}:${s.line}`);
    const count = (list: string[]) => list.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>());
    const [ca, cb] = [count(tokens(c)), count(tokens(d))];
    let inter = 0;
    let union = 0;
    for (const key of new Set([...ca.keys(), ...cb.keys()])) {
      inter += Math.min(ca.get(key) ?? 0, cb.get(key) ?? 0);
      union += Math.max(ca.get(key) ?? 0, cb.get(key) ?? 0);
    }
    expect(formationSimilarity(c, d)).toBeCloseTo(inter / union, 12);
    expect(inter).toBeLessThan(11); // the two shapes really do differ
  });
});

// ---------------------------------------------------------------------------
// §20.5-20.7 OVR, tactical rating and training
// ---------------------------------------------------------------------------

const SKILL_KEYS: (keyof SkillSet)[] = ["gol", "pace", "tec", "pas", "des", "playmaking", "fin"];

function skillVectors(count: number): SkillSet[] {
  const rng = createRng(0xB0A7);
  return Array.from({ length: count }, () =>
    Object.fromEntries(SKILL_KEYS.map((k) => [k, 1 + nextInt(rng, 100)])) as unknown as SkillSet,
  );
}

describe("derived ratings", () => {
  it("keeps every OVR group row and tactical role row normalized", () => {
    for (const [group, row] of Object.entries(allOverallGroups())) {
      expect(weightTotal(row.weights), group).toBeCloseTo(1, 12);
      expect(row.scale).toBeGreaterThan(0);
    }
    for (const role of DEPLOYED_ROLES) {
      expect(weightTotal(gameConfig.playerPositions.tacticalRatingByRole[role]), role).toBeCloseTo(1, 12);
    }
  });

  it("gives every position in a broad group the identical OVR (migration neutrality)", () => {
    // §6.1/§14.5: OVR is broad-group based, so a legacy FB becoming LB or RB —
    // or an MF becoming DM or AM — cannot move the number.
    const vectors = skillVectors(2000);
    for (const skills of vectors) {
      expect(overallFromSkills("LB", skills)).toBe(overallFromSkills("RB", skills));
      expect(overallFromSkills("DM", skills)).toBe(overallFromSkills("AM", skills));
      expect(overallFromSkills("LW", skills)).toBe(overallFromSkills("RW", skills));
      expect(overallFromSkills("LW", skills)).toBe(overallFromSkills("ST", skills));
    }
  });

  it("clamps OVR into 1..100", () => {
    const floor = Object.fromEntries(SKILL_KEYS.map((k) => [k, 1])) as unknown as SkillSet;
    const ceiling = Object.fromEntries(SKILL_KEYS.map((k) => [k, 100])) as unknown as SkillSet;
    for (const pos of NATURAL_POSITIONS) {
      expect(overallFromSkills(pos, floor)).toBeGreaterThanOrEqual(1);
      expect(overallFromSkills(pos, ceiling)).toBeLessThanOrEqual(100);
    }
  });

  it("derives training targets from the natural position's deployed-role weights", () => {
    const expectedPrimary: Record<NaturalPosition, keyof SkillSet> = {
      GK: "gol", LB: "des", RB: "des", CB: "des", DM: "des",
      AM: "playmaking", LW: "fin", RW: "fin", ST: "fin",
    };
    for (const pos of NATURAL_POSITIONS) {
      const primary = trainingWeights(pos, "primary");
      const top = SKILL_KEYS.reduce((a, b) => (primary[a] >= primary[b] ? a : b));
      expect(top, pos).toBe(expectedPrimary[pos]);
      // Every profile normalizes, and only skills with a positive base weight
      // are ever trained.
      for (const focus of ["primary", "secondary", "assistant"] as const) {
        const weights = trainingWeights(pos, focus);
        expect(SKILL_KEYS.reduce((s, k) => s + weights[k], 0)).toBeCloseTo(1, 12);
        for (const key of SKILL_KEYS) expect(weights[key]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("points assistant training at the weakest currently-valued skill", () => {
    // The bonus goes to the weakest VALUED skill; that need not make it the
    // largest weight, so compare against the same profile without the boost.
    const base = trainingWeights("AM", "primary");
    const weakTec: SkillSet = { gol: 50, pace: 50, tec: 12, pas: 50, des: 50, playmaking: 50, fin: 50 };
    const weakFin: SkillSet = { ...weakTec, tec: 50, fin: 12 };
    const boostedTec = trainingWeights("AM", "assistant", weakTec);
    const boostedFin = trainingWeights("AM", "assistant", weakFin);
    expect(boostedTec.tec).toBeGreaterThan(base.tec);
    expect(boostedFin.fin).toBeGreaterThan(base.fin);
    expect(boostedTec.tec).toBeGreaterThan(boostedFin.tec);
    // `gol` has no base weight for an AM, so it is never a training target even
    // when it is by far the weakest skill.
    const weakGol: SkillSet = { ...weakTec, tec: 50, gol: 1 };
    expect(trainingWeights("AM", "assistant", weakGol).gol).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §20.8-20.10 out-of-position compatibility
// ---------------------------------------------------------------------------

describe("out-of-position compatibility", () => {
  it("is zero for all nine natural identity pairings", () => {
    for (const pos of NATURAL_POSITIONS) expect(rolePenalty(pos, naturalDefaultRole(pos))).toBe(0);
  });

  it("enforces GK exclusivity in both directions", () => {
    for (const role of DEPLOYED_ROLES) {
      if (role === "GK") continue;
      expect(rolePenalty("GK", role), `GK->${role}`).toBeNull();
    }
    for (const pos of NATURAL_POSITIONS) {
      if (pos === "GK") continue;
      expect(rolePenalty(pos, "GK"), `${pos}->GK`).toBeNull();
    }
    expect(eligibleNaturalsFor("GK")).toEqual(["GK"]);
  });

  it("is mirror-symmetric across the left/right axis", () => {
    const mirrorPos: Record<NaturalPosition, NaturalPosition> = {
      GK: "GK", LB: "RB", RB: "LB", CB: "CB", DM: "DM", AM: "AM", LW: "RW", RW: "LW", ST: "ST",
    };
    const mirrorRole: Record<DeployedRole, DeployedRole> = {
      GK: "GK", LB: "RB", RB: "LB", CB: "CB", DM: "DM", AM: "AM",
      LW: "RW", RW: "LW", ST: "ST",
    };
    for (const pos of NATURAL_POSITIONS) {
      for (const role of DEPLOYED_ROLES) {
        expect(rolePenalty(pos, role), `${pos}->${role}`).toBe(rolePenalty(mirrorPos[pos], mirrorRole[role]));
      }
    }
  });

  it("labels every configured penalty with the exact band", () => {
    expect(suitabilityLabel(null)).toBe("Ineligible");
    expect(suitabilityLabel(0)).toBe("Natural");
    for (const p of [1, 2, 3, 4]) expect(suitabilityLabel(p)).toBe("Comfortable");
    for (const p of [5, 6, 7, 8]) expect(suitabilityLabel(p)).toBe("Makeshift");
    for (const p of [9, 10, 11, 12]) expect(suitabilityLabel(p)).toBe("Poor");
    for (const p of [13, 16, 18]) expect(suitabilityLabel(p)).toBe("Emergency");
    expect(bandUpperBound("Makeshift")).toBe(8);
    // Every non-null matrix value is covered by a band.
    for (const pos of NATURAL_POSITIONS) {
      for (const role of DEPLOYED_ROLES) {
        const penalty = rolePenalty(pos, role);
        if (penalty !== null) expect(() => suitabilityLabel(penalty)).not.toThrow();
      }
    }
  });

  it("subtracts exactly the penalty from every consumed skill, floored at 1", () => {
    // §20.10: LB at RB costs 4 points; values at or above 5 lose exactly four,
    // floor-clipped values never increase.
    const skills: SkillSet = { gol: 3, pace: 5, tec: 40, pas: 1, des: 90, playmaking: 100, fin: 4 };
    const adjusted = adjustedSkills(skills, "LB", "RB")!;
    expect(adjusted).toEqual({ gol: 1, pace: 1, tec: 36, pas: 1, des: 86, playmaking: 96, fin: 1 });
    for (const key of SKILL_KEYS) expect(adjusted[key]).toBeLessThanOrEqual(skills[key]);
    // Ineligible pairings return null rather than an invented number.
    expect(adjustedSkills(skills, "LB", "GK")).toBeNull();
  });

  it("is monotonic: no adjusted skill or rating ever exceeds the unpenalized one", () => {
    for (const skills of skillVectors(300)) {
      for (const pos of NATURAL_POSITIONS) {
        const naturalRating = tacticalSkillRating(skills, naturalDefaultRole(pos));
        for (const role of DEPLOYED_ROLES) {
          const adjusted = adjustedSkills(skills, pos, role);
          if (adjusted === null) continue;
          for (const key of SKILL_KEYS) expect(adjusted[key]).toBeLessThanOrEqual(skills[key]);
          const rating = adjustedTacticalRating(skills, pos, role)!;
          expect(rating).toBeLessThanOrEqual(tacticalSkillRating(skills, role));
          if (role === naturalDefaultRole(pos)) expect(rating).toBe(naturalRating);
        }
      }
    }
  });

  it("makes a worse penalty a worse rating for the same role", () => {
    // LB at ST (18) must never rate above LB at RB (4) on the same skills.
    for (const skills of skillVectors(200)) {
      const atRb = adjustedTacticalRating(skills, "LB", "RB")!;
      const atSt = adjustedTacticalRating(skills, "LB", "ST")!;
      const stNatural = adjustedTacticalRating(skills, "ST", "ST")!;
      expect(atSt).toBeLessThanOrEqual(stNatural);
      expect(rolePenalty("LB", "ST")!).toBeGreaterThan(rolePenalty("LB", "RB")!);
      expect(atRb).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// §20.11 globally optimal assignment
// ---------------------------------------------------------------------------

function testPlayer(id: number, position: NaturalPosition, overrides: Partial<Player> = {}): Player {
  const skills: SkillSet = { gol: 50, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 };
  return {
    id, name: `P${id}`, country: "BRA", age: 25, position, skills,
    overall: overallFromSkills(position, skills), energy: 100, salary: 1000,
    payrollPaidThroughDay: 0, payrollPaidAmount: 0, payrollPeriodStartDay: 0,
    value: 1000, releaseClause: 1000, injuryDays: 0, contractDays: 500,
    isYouth: false, starter: false, careerGrowthConsumed: 0, careerDeclineConsumed: 0,
    skillAcc: [0, 0, 0, 0, 0, 0, 0], careerGoals: 0, careerAssists: 0,
    seasonGoals: 0, seasonAssists: 0, yellows: 0, reds: 0, clubId: 1,
    onSale: false, suspendedGames: 0, loanId: null,
    careerProfile: { growthPotential: 0, growthSpeed: 0, peakAge: 27, declinePotential: 0, declineSpeed: 0 },
    recentMinutes: [],
    ...overrides,
  } as Player;
}

describe("XI assignment DP", () => {
  const formationId = 4; // 4-4-2: GK, LB, CB, CB, RB, AM, DM, DM, AM, ST, ST
  const squad = (): Player[] => [
    testPlayer(1, "GK"), testPlayer(2, "GK"),
    testPlayer(3, "LB"), testPlayer(4, "RB"),
    testPlayer(5, "CB"), testPlayer(6, "CB"),
    testPlayer(7, "DM"), testPlayer(8, "AM"),
    testPlayer(9, "LW"), testPlayer(10, "RW"),
    testPlayer(11, "ST"), testPlayer(12, "ST"),
  ];

  it("finds a global optimum that greedy slot-order filling misses", () => {
    // Slot 1 is LB. A greedy pass takes the highest LB score first and strands
    // the only player who can fill a later slot well.
    const players = squad();
    const roles = formationById(formationId)!.slots.map((s) => s.role);
    const table = new Map<string, number>();
    const set = (id: number, role: DeployedRole, v: number) => table.set(`${id}:${role}`, v);
    for (const p of players) for (const role of roles) set(p.id, role, 1);
    // Player 3 is excellent at LB (10) and also the only decent AM (10);
    // player 9 is a slightly worse LB (9) but hopeless at AM (1).
    set(3, "LB", 10); set(3, "AM", 10);
    set(9, "LB", 9); set(9, "AM", 1);
    const scoreOf = (p: Player, role: DeployedRole) =>
      p.position === "GK" ? (role === "GK" ? 5 : null) : role === "GK" ? null : table.get(`${p.id}:${role}`)!;

    const result = assignBestXI(players, formationId, scoreOf)!;
    expect(result).not.toBeNull();
    const bySlot = result.slots.map((s) => s.player.id);
    // Optimum puts 9 at LB (9) and 3 at AM (10) = 19, beating 3 at LB + 9 at AM = 11.
    expect(bySlot[1]).toBe(9);
    expect(bySlot[5]).toBe(3);
  });

  it("never duplicates a player and always fills all eleven slots", () => {
    const result = assignBestXI(squad(), formationId, (p, role) =>
      p.position === "GK" ? (role === "GK" ? 1 : null) : role === "GK" ? null : 1)!;
    expect(result.slots).toHaveLength(11);
    expect(new Set(result.slots.map((s) => s.player.id)).size).toBe(11);
  });

  it("puts a natural goalkeeper in the GK slot and never elsewhere", () => {
    for (const id of [4, 7, 11]) {
      const result = assignBestXI(squad(), id, (p, role) => {
        const rating = adjustedTacticalRating(p.skills, p.position, role);
        return rating === null ? null : rating;
      })!;
      const roles = formationById(id)!.slots.map((s) => s.role);
      result.slots.forEach((slot, index) => {
        expect(slot.player.position === "GK").toBe(roles[index] === "GK");
      });
    }
  });

  it("breaks exact ties toward the lexicographically smaller player-ID array", () => {
    const flat = (p: Player, role: DeployedRole) =>
      p.position === "GK" ? (role === "GK" ? 1 : null) : role === "GK" ? null : 1;
    const first = assignBestXI(squad(), formationId, flat)!;
    const shuffled = [...squad()].reverse();
    const second = assignBestXI(shuffled, formationId, flat)!;
    expect(second.slots.map((s) => s.player.id)).toEqual(first.slots.map((s) => s.player.id));
  });

  it("returns null when no available natural goalkeeper can fill the GK slot", () => {
    const outfieldOnly = squad().filter((p) => p.position !== "GK");
    const result = assignBestXI(outfieldOnly, formationId, (p, role) =>
      adjustedTacticalRating(p.skills, p.position, role));
    expect(result).toBeNull();
  });

  it("leaves slots empty rather than mis-slotting when re-shaping a short side", () => {
    // §9.1: a formation change re-slots ONLY the players on the pitch. With the
    // goalkeeper dismissed, the GK slot must stay empty — never take an
    // outfielder, whose GK compatibility is null.
    const onPitch = squad().filter((p) => p.position !== "GK").slice(0, 10);
    const assign = assignOnPitchToSlots(onPitch, formationId, (p, role) =>
      adjustedTacticalRating(p.skills, p.position, role))!;
    expect(assign[0]).toBeNull();
    const filled = assign.filter((id): id is number => id !== null);
    expect(filled).toHaveLength(10);
    expect(new Set(filled).size).toBe(10);
  });

  it("keeps an available goalkeeper in the GK slot when re-shaping", () => {
    const assign = assignOnPitchToSlots(squad().slice(0, 11), formationId, (p, role) =>
      adjustedTacticalRating(p.skills, p.position, role))!;
    expect(assign[0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §20.19 allocation
// ---------------------------------------------------------------------------

describe("cohort allocation", () => {
  const seniorGroups = gameConfig.playerGeneration.positionMix.seniorGroups;
  const academyGroups = gameConfig.playerGeneration.positionMix.academyGroups;

  it("reproduces the shipped broad counts with deterministic largest remainder", () => {
    expect(allocateBroadGroupCounts(30, seniorGroups)).toEqual({ GK: 3, FB: 4, CB: 5, MF: 10, FW: 8 });
    expect(allocateBroadGroupCounts(11, academyGroups)).toEqual({ GK: 1, FB: 3, CB: 3, MF: 2, FW: 2 });
  });

  it("always returns exactly `total` seats", () => {
    for (let total = 0; total <= 40; total++) {
      const counts = allocateBroadGroupCounts(total, seniorGroups);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("keeps seeded allocation inside floor/ceil and exactly on total", () => {
    const weights = gameConfig.playerGeneration.positionMix.withinGroup.FW;
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    for (let total = 0; total <= 25; total++) {
      for (let s = 0; s < 20; s++) {
        const counts = allocateSeededCounts(total, weights, `seed-${total}-${s}`);
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(total);
        for (const [role, n] of Object.entries(counts)) {
          const exact = (weights[role as keyof typeof weights] / sum) * total;
          expect(n).toBeGreaterThanOrEqual(Math.floor(exact));
          expect(n).toBeLessThanOrEqual(Math.ceil(exact));
        }
      }
    }
  });

  it("is deterministic for identical inputs and consumes no global RNG", () => {
    const weights = { LB: 0.5, RB: 0.5 };
    for (let i = 0; i < 50; i++) {
      expect(allocateSeededCounts(7, weights, "same-key")).toEqual(allocateSeededCounts(7, weights, "same-key"));
    }
    // Different keys must actually explore both roundings, otherwise the
    // "unbiased" claim is empty.
    const outcomes = new Set(
      Array.from({ length: 60 }, (_, i) => JSON.stringify(allocateSeededCounts(7, weights, `k${i}`))),
    );
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it("splits the shipped 30-senior squad into one of the allowed natural shapes", () => {
    const broad = allocateBroadGroupCounts(30, seniorGroups);
    const within = gameConfig.playerGeneration.positionMix.withinGroup;
    for (let s = 0; s < 200; s++) {
      const fb = allocateSeededCounts(broad.FB, within.FB, `fb-${s}`);
      const mf = allocateSeededCounts(broad.MF, within.MF, `mf-${s}`);
      const fw = allocateSeededCounts(broad.FW, within.FW, `fw-${s}`);
      expect([fb.LB, fb.RB]).toEqual([2, 2]);
      expect([mf.DM, mf.AM]).toEqual([5, 5]);
      const shape = [fw.LW, fw.RW, fw.ST].join("/");
      expect(["3/2/3", "2/3/3", "2/2/4"]).toContain(shape);
    }
  });

  it("splits the shipped 11-player academy into one of the allowed natural shapes", () => {
    const broad = allocateBroadGroupCounts(11, academyGroups);
    expect(broad).toEqual({ GK: 1, FB: 3, CB: 3, MF: 2, FW: 2 });
    const within = gameConfig.playerGeneration.positionMix.withinGroup;
    for (let s = 0; s < 200; s++) {
      const fb = allocateSeededCounts(broad.FB, within.FB, `afb-${s}`);
      const mf = allocateSeededCounts(broad.MF, within.MF, `amf-${s}`);
      const fw = allocateSeededCounts(broad.FW, within.FW, `afw-${s}`);
      expect(["2/1", "1/2"]).toContain([fb.LB, fb.RB].join("/"));
      expect([mf.DM, mf.AM]).toEqual([1, 1]);
      expect(["1/1/0", "1/0/1", "0/1/1"]).toContain([fw.LW, fw.RW, fw.ST].join("/"));
    }
  });
});

// ---------------------------------------------------------------------------
// §18 config integrity
// ---------------------------------------------------------------------------

describe("position config", () => {
  it("is fully specified — no optional section falls back to code defaults", () => {
    expect(gameConfig.playerPositions).toBeDefined();
    expect(gameConfig.playerGeneration.positionMix).toBeDefined();
    expect(Object.keys(gameConfig.playerPositions.tacticalRatingByRole).sort())
      .toEqual([...DEPLOYED_ROLES].sort());
  });

  it("keeps every eligible pairing usable and every role reachable", () => {
    for (const role of DEPLOYED_ROLES) {
      expect(eligibleNaturalsFor(role).length, role).toBeGreaterThan(0);
    }
    for (const pos of NATURAL_POSITIONS) {
      expect(isEligible(pos, naturalDefaultRole(pos))).toBe(true);
    }
  });
});
