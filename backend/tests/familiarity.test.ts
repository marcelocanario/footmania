import { describe, expect, it } from "vitest";
import {
  INITIAL_FAMILIARITY,
  applyMatchFamiliarity,
  canonicalFromClub,
  decayedStoredFamiliarity,
  effectiveFamiliarity,
  projectSetups,
  recordSwitch,
  setupKey,
  switchFamiliarity,
  setupSimilarity,
  tacticalExecution,
  tacticalExecutionContrast,
} from "../src/game/familiarity";
import { createLiveMatchState, applyLiveTacticsUpdate, applyLiveFormationChange, rebuildLiveHumanLineup, tickLiveMatch } from "../src/game/match";
import { finalizeLiveMatch } from "../src/game/world";
import { makeWorld } from "./helpers";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { FORMATION_POSITIONS, STYLE_NAMES, PRESSING_NAMES, DIRECTION_NAMES } from "../src/game/constants";
import type { Club, Player } from "../src/game/types";

let clubId = 1;

describe("tactical familiarity: execution scale", () => {
  it("is linear, bounded, and never exceeds the configured tactical share", () => {
    expect(tacticalExecution(-10)).toBe(tacticalExecution(0));
    expect(tacticalExecution(50)).toBeCloseTo((tacticalExecution(0) + tacticalExecution(100)) / 2, 10);
    expect(tacticalExecution(110)).toBe(tacticalExecution(100));
    expect(tacticalExecution(25)).toBeLessThan(tacticalExecution(50));
    expect(tacticalExecution(50)).toBeLessThan(tacticalExecution(90));
  });

  it("centers common execution and preserves only the familiarity gap", () => {
    const reference = tacticalExecution(50);
    expect(tacticalExecutionContrast(25, 25)).toBeCloseTo(reference, 10);
    expect(tacticalExecutionContrast(90, 90)).toBeCloseTo(reference, 10);
    expect(tacticalExecutionContrast(90, 25)).toBeGreaterThan(reference);
    expect(tacticalExecutionContrast(25, 90)).toBeLessThan(reference);
  });
});

function club(overrides: Partial<Club> = {}): Club {
  return {
    id: clubId++,
    name: "Fam FC",
    shortName: "FFC",
    ownerUserId: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    highestDivision: 1,
    cash: 1_000_000,
    stadiumName: "St",
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
    ...overrides,
  };
}

function squad(rng: ReturnType<typeof createRng>, forClub: Club): Player[] {
  const balanced = [0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4] as const;
  return balanced.map((position, i) => generatePlayer(rng, forClub, { id: forClub.id * 1000 + i + 1, position }));
}

function jaccard(a: number, b: number): number {
  const ca = new Map<number, number>();
  const cb = new Map<number, number>();
  for (const s of FORMATION_POSITIONS[a]) ca.set(s, (ca.get(s) ?? 0) + 1);
  for (const s of FORMATION_POSITIONS[b]) cb.set(s, (cb.get(s) ?? 0) + 1);
  let inter = 0;
  let union = 0;
  for (const s of new Set([...ca.keys(), ...cb.keys()])) {
    inter += Math.min(ca.get(s) ?? 0, cb.get(s) ?? 0);
    union += Math.max(ca.get(s) ?? 0, cb.get(s) ?? 0);
  }
  return inter / union;
}

describe("tactical familiarity: growth", () => {
  it("starts untracked setups at the neutral midpoint", () => {
    const c = club();
    expect(effectiveFamiliarity(c, 500)).toBe(INITIAL_FAMILIARITY);
  });

  it("grows per completed match toward ~95% after one season of games", () => {
    const c = club();
    const gamesPerSeason = 14; // gameConfig.roundsPerSeason default
    const rate = 1 - Math.exp(-3 / gamesPerSeason);
    applyMatchFamiliarity(c, 0);
    const expectedOne = INITIAL_FAMILIARITY + (100 - INITIAL_FAMILIARITY) * rate;
    expect(c.tacticFamiliarity?.[setupKey(c.tactics)]?.familiarity).toBeCloseTo(expectedOne, 1);

    // A full season played with zero idle days isolates the pure §17 growth
    // curve (idle decay between match days is covered by the decay tests).
    for (let game = 1; game < gamesPerSeason; game++) applyMatchFamiliarity(c, 0);
    const value = c.tacticFamiliarity?.[setupKey(c.tactics)]?.familiarity ?? 0;
    // §17 target: after G games, f = 100 - (100 - start) * e^(-seasonTargetExponent)
    expect(value).toBeCloseTo(100 - 50 * Math.exp(-3), 1);
    expect(value).toBeLessThanOrEqual(100);
  });

  it("is monotonic and clamped at 100", () => {
    const c = club();
    let previous = effectiveFamiliarity(c, 0);
    for (let day = 0; day < 60; day++) {
      applyMatchFamiliarity(c, day);
      const current = c.tacticFamiliarity![setupKey(c.tactics)].familiarity;
      expect(current).toBeGreaterThanOrEqual(previous);
      expect(current).toBeLessThanOrEqual(100);
      previous = current;
    }
    expect(previous).toBeLessThan(100);
  });

  it("only grows the setup that actually played", () => {
    const c = club({ tactics: { formation: 7, style: 2, pressing: 2, direction: 1 } });
    applyMatchFamiliarity(c, 5);
    expect(Object.keys(c.tacticFamiliarity!)).toEqual([setupKey(c.tactics)]);
  });
});

describe("tactical familiarity: decay", () => {
  it("applies lazy idle decay since the last used day", () => {
    const key = "4-0-0-0";
    const c = club({ tacticFamiliarity: { [key]: { familiarity: 80, lastUsedAbsoluteGameDay: 10 } } });
    // Same day: no decay.
    expect(effectiveFamiliarity(c, 10)).toBe(80);
    // 10 idle days: 80 * e^(-0.005 * 10).
    expect(effectiveFamiliarity(c, 20)).toBeCloseTo(80 * Math.exp(-0.05), 5);
  });

  it("reads are pure: repeated reads never double-decay or mutate state", () => {
    const key = "4-0-0-0";
    const stored = { [key]: { familiarity: 80, lastUsedAbsoluteGameDay: 0 } };
    const c = club({ tacticFamiliarity: stored });
    const first = effectiveFamiliarity(c, 100);
    const second = effectiveFamiliarity(c, 100);
    expect(first).toBe(second);
    expect(stored[key].familiarity).toBe(80);
  });

  it("never-used setups do not decay before their first match", () => {
    const c = club({ tacticFamiliarity: { "4-0-0-0": { familiarity: 70, lastUsedAbsoluteGameDay: null } } });
    expect(effectiveFamiliarity(c, 400)).toBe(70);
  });

  it("decays lazily when reading stored progress for projections", () => {
    const map = { "4-2-0-0": { familiarity: 90, lastUsedAbsoluteGameDay: 0 } };
    expect(decayedStoredFamiliarity(map, "4-2-0-0", 100)).toBeCloseTo(90 * Math.exp(-0.5), 2);
    expect(decayedStoredFamiliarity(map, "7-0-0-0", 100)).toBeNull();
    expect(decayedStoredFamiliarity(undefined, "4-2-0-0", 100)).toBeNull();
  });
});

describe("tactical familiarity: similarity and switch transfer", () => {
  it("scores identical setups 1", () => {
    const a = canonicalFromClub({ formation: 4, style: 1, pressing: 2, direction: 1 });
    expect(setupSimilarity(a, a)).toBe(1);
  });

  it("weights formation-only changes by structural slot overlap", () => {
    // Only the formation differs: three of four components stay at 1.
    const a = canonicalFromClub({ formation: 4, style: 0, pressing: 0, direction: 0 });
    const b = canonicalFromClub({ formation: 7, style: 0, pressing: 0, direction: 0 });
    const expected = 0.75 + 0.25 * jaccard(4, 7);
    expect(setupSimilarity(a, b)).toBeCloseTo(expected, 6);
    expect(setupSimilarity(a, b)).toBeGreaterThan(0.75);
    expect(setupSimilarity(a, b)).toBeLessThan(1);
  });

  it("scores maximally distant setups within the same formation at the weight floor", () => {
    const a = canonicalFromClub({ formation: 4, style: 0, pressing: 0, direction: 0 });
    const b = canonicalFromClub({ formation: 4, style: 2, pressing: 2, direction: 1 });
    expect(setupSimilarity(a, b)).toBeCloseTo(0.25, 6);
  });

  it("switch into an undrilled setup starts from the configured floor plus partial credit", () => {
    // Identical setups (sim=1): base 25 + (90-25)*0.35.
    const setup = canonicalFromClub({ formation: 4, style: 0, pressing: 0, direction: 0 });
    expect(switchFamiliarity(90, setup, setup, null)).toBeCloseTo(25 + 65 * 0.35, 5);
    // Maximal distance within formation (sim=0.25): floor dominates.
    const other = canonicalFromClub({ formation: 4, style: 2, pressing: 2, direction: 1 });
    expect(switchFamiliarity(90, setup, other, null)).toBeCloseTo(25 + 65 * 0.25 * 0.35, 2);
  });

  it("a previously drilled destination keeps its (decayed) progress as the base", () => {
    const src = canonicalFromClub({ formation: 4, style: 0, pressing: 0, direction: 0 });
    const dst = canonicalFromClub({ formation: 4, style: 2, pressing: 0, direction: 0 });
    // Drilled at 80 > floor: base 80, only the surplus transfers.
    expect(switchFamiliarity(90, src, dst, 80)).toBeCloseTo(80 + 10 * setupSimilarity(src, dst) * 0.35, 2);
    // Source below the base contributes nothing.
    expect(switchFamiliarity(50, src, dst, 80)).toBe(80);
  });

  it("clamps results to the 0..100 scale", () => {
    const setup = canonicalFromClub({ formation: 4, style: 0, pressing: 0, direction: 0 });
    expect(switchFamiliarity(100, setup, setup, 99)).toBeLessThanOrEqual(100);
    expect(switchFamiliarity(100, setup, setup, null)).toBeLessThanOrEqual(100);
  });
});

describe("tactical familiarity: persistent switches", () => {
  it("recordSwitch preserves the abandoned setup's progress and anchors the destination", () => {
    const oldTactics = { formation: 4, style: 0, pressing: 0, direction: 0 };
    const c = club({ tactics: oldTactics, tacticFamiliarity: { [setupKey(oldTactics)]: { familiarity: 88, lastUsedAbsoluteGameDay: 12 } } });
    const next = { formation: 7, style: 1, pressing: 2, direction: 1 };
    recordSwitch(c, next, 41);
    expect(c.tacticFamiliarity![setupKey(oldTactics)]).toEqual({ familiarity: 88, lastUsedAbsoluteGameDay: 12 });
    expect(c.tacticFamiliarity![setupKey(next)]).toEqual({ familiarity: 41, lastUsedAbsoluteGameDay: null });
  });

  it("caps tracked setups, evicting the least familiar first", () => {
    const map: Record<string, { familiarity: number; lastUsedAbsoluteGameDay: number | null }> = {};
    for (let i = 0; i < 15; i++) map[`${i}-${0}-0-0`] = { familiarity: 10 + i, lastUsedAbsoluteGameDay: null };
    const keep = { formation: 99, style: 0, pressing: 0, direction: 0 };
    const c = club({ tacticFamiliarity: map });
    recordSwitch(c, keep, 55);
    expect(Object.keys(c.tacticFamiliarity!).length).toBeLessThanOrEqual(12);
    expect(c.tacticFamiliarity![setupKey(keep)]?.familiarity).toBe(55);
    // Lowest-familiarity rows were evicted, highest survived.
    expect(c.tacticFamiliarity!["14-0-0-0"]).toBeDefined();
    expect(c.tacticFamiliarity!["0-0-0-0"]).toBeUndefined();
  });

  it("sanitizes malformed persisted maps instead of crashing", () => {
    const broken = club({
      tacticFamiliarity: {
        "4-0-0-0": { familiarity: Number.NaN, lastUsedAbsoluteGameDay: null },
        broken: "nope",
      } as unknown as Club["tacticFamiliarity"],
    });
    expect(decayedStoredFamiliarity(broken.tacticFamiliarity, "4-0-0-0")).toBeNull();
    // Out-of-range values are clamped back into the scale.
    const extreme = { "7-0-0-0": { familiarity: 120, lastUsedAbsoluteGameDay: -5 } } as Club["tacticFamiliarity"];
    expect(decayedStoredFamiliarity(extreme, "7-0-0-0", 0)).toBe(100);
  });
});

describe("tactical familiarity: engine integration", () => {
  it("projects every style x pressing x direction combination server-side", () => {
    const srcSetup = canonicalFromClub({ formation: 4, style: 0, pressing: 0, direction: 0 });
    const projections = projectSetups(
      62,
      srcSetup,
      4,
      STYLE_NAMES.length,
      PRESSING_NAMES.length,
      DIRECTION_NAMES.length,
      (style, pressing, direction) => (style === 0 && pressing === 0 && direction === 0 ? 62 : null)
    );
    expect(projections.length).toBe(STYLE_NAMES.length * PRESSING_NAMES.length * DIRECTION_NAMES.length);
    // With consistent stored progress, projecting the current setup is the identity.
    expect(projections.find((p) => p.style === 0 && p.pressing === 0 && p.direction === 0)?.familiarity).toBe(62);
    // Every projection stays in scale and never exceeds switching to an identical setup.
    for (const p of projections) {
      expect(p.familiarity).toBeGreaterThanOrEqual(25);
      expect(p.familiarity).toBeLessThanOrEqual(62);
    }
  });

  it("kickoff snapshots each side's drilled familiarity instead of a constant", () => {
    const rng = createRng(7);
    const home = club({ id: 1, tactics: { formation: 4, style: 0, pressing: 0, direction: 0 }, tacticFamiliarity: { "4-0-0-0": { familiarity: 80, lastUsedAbsoluteGameDay: null } } });
    const away = club({ id: 2, tactics: { formation: 4, style: 0, pressing: 0, direction: 0 } });
    const players = [...squad(rng, home), ...squad(rng, away)];
    const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });
    expect(st.homeTactics.familiarity).toBe(80);
    expect(st.awayTactics.familiarity).toBe(INITIAL_FAMILIARITY);
  });

  it("applies the §17 switch penalty to live in-match changes", () => {
    const state = () =>
      ({
        ended: false,
        minute: 30,
        homeTactics: { formation: 4, style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 80 },
        awayTactics: { formation: 4, style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
      }) as Parameters<typeof applyLiveTacticsUpdate>[0];

    // Undrilled destination, no club context: starts from the configured floor
    // plus partial credit. CONTROL vs COUNTER at the same shape scores sim 0.75,
    // so 25 + (80 - 25) * 0.75 * 0.35.
    const st = state();
    expect(applyLiveTacticsUpdate(st, 0, { style: 2 })).toBeNull();
    expect(st.homeTactics.familiarity).toBeCloseTo(39.44, 2);

    // A drilled destination keeps its stored progress as the base.
    const drilled = state();
    expect(
      applyLiveTacticsUpdate(drilled, 0, { style: 2 }, {
        familiarityMap: { "4-2-0-0": { familiarity: 70, lastUsedAbsoluteGameDay: null } },
        absoluteGameDay: 40,
      })
    ).toBeNull();
    expect(drilled.homeTactics.familiarity).toBeCloseTo(70 + 10 * 0.75 * 0.35, 2);
  });

  it("does not re-apply a penalty when the applied setup is unchanged", () => {
    const st = {
      ended: false,
      minute: 0,
      homeTactics: { formation: 4, style: "COUNTER", pressing: 0, direction: "CENTRE", familiarity: 39.44 },
      awayTactics: { formation: 4, style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
    } as Parameters<typeof applyLiveTacticsUpdate>[0];
    expect(applyLiveTacticsUpdate(st, 0, { style: 2 })).toBeNull();
    expect(st.homeTactics.familiarity).toBe(39.44);
  });

  it("prices interval formation changes through the same §17 transfer", () => {
    const rng = createRng(21);
    const home = club({ id: 301, tacticFamiliarity: { "4-0-0-0": { familiarity: 80, lastUsedAbsoluteGameDay: null } } });
    const away = club({ id: 302 });
    const players = [...squad(rng, home), ...squad(rng, away)];
    const st = createLiveMatchState(rng, home, away, players, { matchId: 51, competitionId: 1, fixtureId: 52 });
    expect(st.homeTactics.familiarity).toBe(80);

    // Live play rejects formation changes outright.
    st.matchClockSeconds = 1;
    expect(applyLiveFormationChange(st, 0, 7, {})).toMatch(/kickoff or at half-time/i);

    // At the interval an actual shape change pays the transfer; same shape is free.
    // First half includes stoppage (base + events), so tick well past 45'.
    tickLiveMatch(rng, home, away, players, st, 52);
    const context = { familiarityMap: home.tacticFamiliarity, absoluteGameDay: 5 };
    expect(applyLiveFormationChange(st, 0, 7, context)).toBeNull();
    const jaccard47 = jaccard(4, 7);
    expect(st.homeTactics.familiarity).toBeCloseTo(25 + 55 * (0.75 + 0.25 * jaccard47) * 0.35, 2);
    const afterSwitch = st.homeTactics.familiarity;
    expect(applyLiveFormationChange(st, 0, 7, context)).toBeNull();
    expect(st.homeTactics.familiarity).toBe(afterSwitch);
    expect(applyLiveFormationChange(st, 0, 99, context)).toBe("Invalid formation");
  });

  it("rebuildLiveHumanLineup applies the penalty when the drilled formation changed at halftime", () => {
    const rng = createRng(22);
    const human = club({ id: 401, tacticFamiliarity: { "4-0-0-0": { familiarity: 80, lastUsedAbsoluteGameDay: null } } });
    const opponent = club({ id: 402 });
    const players = [...squad(rng, human), ...squad(rng, opponent)];
    const st = createLiveMatchState(rng, human, opponent, players, { matchId: 61, competitionId: 1, fixtureId: 62 });
    tickLiveMatch(rng, human, opponent, players, st, 52);

    human.tactics = { ...human.tactics, formation: 7 };
    rebuildLiveHumanLineup(st, human, players, { absoluteGameDay: 5 });
    expect(st.homeTactics.formation).toBe(7);
    expect(st.homeTactics.familiarity).toBeCloseTo(25 + 55 * (0.75 + 0.25 * jaccard(4, 7)) * 0.35, 2);

    // Rebuilding again with unchanged tactics must not re-apply any penalty.
    const after = st.homeTactics.familiarity;
    rebuildLiveHumanLineup(st, human, players, { absoluteGameDay: 5 });
    expect(st.homeTactics.familiarity).toBe(after);
  });

  it("rebuildLiveHumanLineup prices persistent style/pressing/direction edits picked up at halftime", () => {
    const rng = createRng(23);
    const human = club({ id: 501, tacticFamiliarity: { "4-0-0-0": { familiarity: 80, lastUsedAbsoluteGameDay: null } } });
    const opponent = club({ id: 502 });
    const players = [...squad(rng, human), ...squad(rng, opponent)];
    const st = createLiveMatchState(rng, human, opponent, players, { matchId: 71, competitionId: 1, fixtureId: 72 });
    tickLiveMatch(rng, human, opponent, players, st, 52);

    // Manager saved a persistent COUNTER flip during the interval; the rebuild
    // must price it exactly like a live switch would (sim 0.75, undrilled dst).
    human.tactics = { ...human.tactics, style: 2 };
    rebuildLiveHumanLineup(st, human, players, { absoluteGameDay: 5 });
    expect(st.homeTactics.style).toBe("COUNTER");
    expect(st.homeTactics.formation).toBe(4);
    expect(st.homeTactics.familiarity).toBeCloseTo(25 + 55 * 0.75 * 0.35, 2);

    // And an unchanged rebuild stays free.
    const after = st.homeTactics.familiarity;
    rebuildLiveHumanLineup(st, human, players, { absoluteGameDay: 5 });
    expect(st.homeTactics.familiarity).toBe(after);
  });

  it("finalizeLiveMatch grows both sides once and cannot double-apply", () => {
    const rng = createRng(11);
    const home = club({ id: 101 });
    const away = club({ id: 102 });
    const players = [...squad(rng, home), ...squad(rng, away)];
    const world = makeWorld([home, away], players, { dayIndex: 7 });
    world.fixtures.push({ id: 5001, competitionId: 1, round: 0, homeClubId: 101, awayClubId: 102, dayIndex: 7, played: false });
    const st = createLiveMatchState(world.rng, home, away, players, { matchId: 9001, competitionId: 1, fixtureId: 5001 });
    world.liveMatches.push(st);
    st.ended = true;

    expect(finalizeLiveMatch(world, st)).not.toBeNull();
    const key = setupKey(home.tactics);
    expect(home.tacticFamiliarity?.[key]?.familiarity).toBeGreaterThan(INITIAL_FAMILIARITY);
    expect(home.tacticFamiliarity?.[key]?.lastUsedAbsoluteGameDay).toBe(7);
    expect(away.tacticFamiliarity?.[setupKey(away.tactics)]?.familiarity).toBeGreaterThan(INITIAL_FAMILIARITY);

    // The live state was consumed: a retry must be a no-op (idempotent worker
    // retries / crash recovery can never double-count a game of progress).
    const grown = home.tacticFamiliarity![key].familiarity;
    expect(finalizeLiveMatch(world, st)).toBeNull();
    expect(home.tacticFamiliarity![key].familiarity).toBe(grown);
  });
});
