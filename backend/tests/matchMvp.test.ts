import { describe, expect, it } from "vitest";
import { EVENT_CODES } from "../src/game/constants";
import { createLiveMatchState, ratingObserverFor, tickLiveMatch } from "../src/game/match";
import { finalizeLiveMatch } from "../src/game/world";
import { createRng } from "../src/game/rng";
import { balancedZ, coarseRole, ratingFromBalancedZ, buildRoleBenchmarks, RATING_NEUTRAL, MIN_RATED_MINUTES } from "../src/game/player-rating";
import { computeMatchRatingRows, mvpFromRatings, primaryCoarseRole, liveRatingFromAccum } from "../src/game/matchRatings";
import { createRatingObserver, type RatingDecisionInput } from "../src/game/ratingObserver";
import { DEPLOYED_ROLES, naturalDefaultRole } from "../src/game/positions";
import { simulateDivisionThroughRound } from "../src/game/multiplayer";
import { playerMatchScoreView } from "../src/services/playerPerformance";
import type { Competition, Match, Player, PlayerMatchRatingEntry } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";
import { clonePlayers, goldenClub, goldenSquad, goldenTactics } from "./matchGolden";

/** Build a rating row with the required fields. */
function row(overrides: Partial<PlayerMatchRatingEntry> & { playerId: number; clubId: number }): PlayerMatchRatingEntry {
  return {
    matchId: 1, seasonId: 1, tier: 1, primaryRole: "MID", minutesPlayed: 90,
    rawImpact: 1, rawVariance: 1, rawZ: 1, balancedZ: 1, ratingExact: 6.5,
    shootingImpact: 0, passingImpact: 0, dribblingImpact: 0, defendingImpact: 0, goalkeepingImpact: 0,
    ...overrides,
  };
}

describe("rating math", () => {
  it("maps fine deployed roles to coarse calibration roles", () => {
    expect(coarseRole("GK")).toBe("GK");
    expect(coarseRole("LB")).toBe("FB");
    expect(coarseRole("RB")).toBe("FB");
    expect(coarseRole("CB")).toBe("CB");
    expect(coarseRole("SW")).toBe("CB");
    expect(coarseRole("LM")).toBe("MID");
    expect(coarseRole("RM")).toBe("MID");
    expect(coarseRole("CM")).toBe("MID");
    expect(coarseRole("LW")).toBe("FWD");
    expect(coarseRole("RW")).toBe("FWD");
    expect(coarseRole("ST")).toBe("FWD");
  });

  it("converts Z=0 to the neutral 6.5 rating", () => {
    expect(ratingFromBalancedZ(0)).toBe(RATING_NEUTRAL);
  });

  it("clamps to the 3.0–10.0 scale", () => {
    expect(ratingFromBalancedZ(-10)).toBe(3);
    expect(ratingFromBalancedZ(10)).toBe(10);
  });

  it("Gaussianizes via the empirical percentile (frozen calibration)", () => {
    // A raw Z at the median of a frozen distribution maps near 0 → 6.5.
    const z = balancedZ(0.5, { role: "MID", zRaws: [-1, -0.5, 0, 0.5, 1, 1.5], usable: true });
    expect(z).toBeGreaterThan(-0.5);
    expect(z).toBeLessThan(0.5);
  });

  it("bypasses calibration with fewer than two observations", () => {
    expect(balancedZ(1.2, { role: "GK", zRaws: [0.5], usable: false })).toBe(1.2);
  });

  // §17: benchmarks are keyed by the twelve DEPLOYED roles, not the five coarse
  // groups — a shared MID row would make DM and AM indistinguishable to the
  // rating observer, which is the whole point of the fine-role taxonomy.
  it("builds a median benchmark for every deployed role, not just the coarse groups", () => {
    const players = clonePlayers([...goldenSquad(1, 1, 31111, 1000), ...goldenSquad(2, 4, 32222, 2000)]);
    const benchmarks = buildRoleBenchmarks(players, (p) => naturalDefaultRole(p.position));
    for (const role of DEPLOYED_ROLES) {
      expect(benchmarks[role], `missing benchmark for ${role}`).toBeDefined();
      expect(typeof benchmarks[role].goalkeeping).toBe("number");
      expect(typeof benchmarks[role].technique).toBe("number");
    }
    // Coarse group names are NOT benchmark keys any more.
    expect(benchmarks.MID).toBeUndefined();
    expect(benchmarks.FWD).toBeUndefined();
    // DM and AM sit in the same coarse group but must have distinct rows: the
    // DM pool excludes the roles whose penalty exceeds Makeshift, and vice versa.
    expect(benchmarks.DM).not.toEqual(benchmarks.AM);
    expect(benchmarks.GK.goalkeeping).toBeGreaterThan(benchmarks.ST.goalkeeping);
  });

  it("treats control-failure as routine (no rating contribution)", () => {
    const accum = {} as Record<number, import("../src/game/ratingObserver").PlayerRatingAccum>;
    const player = {
      id: 1, position: "DM" as const, deployedRole: "DM" as const, slotIndex: 3,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 1, zPace: 0, zPhysical: 0, zFinishing: 0, zGk: 0, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const side = {
      involved: [{ ps: player, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
    };
    const context: RatingDecisionInput = {
      phase: "BUILD_UP", zone: "MID_CENTRAL", possessionSide: 0, homeNeutral: true,
      stateValue: 0, possessionThreat: 0.05, homeClubId: 10, awayClubId: 20, sides: { home: side, away: { ...side, involved: [] } },
    };
    const observer = createRatingObserver({
      benchmarks: {
        GK: {}, FB: {}, CB: {}, MID: { technique: 0 }, FWD: {},
      } as import("../src/game/player-rating").RoleBenchmarks,
      fineRoleOf: () => "DM",
      base: accum,
    });

    observer.onDecision("control-failure", context, { FAIL: 0.2, KEEP: 0.8 }, "KEEP", [1]);

    // Control-failure is a routine pre-action fumble check; it carries no
    // rating contribution so it cannot drag every player down ~2500 times a
    // match.
    expect(accum[1]).toBeUndefined();
  });

  it("values outcomes from the participant's own team perspective", () => {
    const accum = {} as Record<number, import("../src/game/ratingObserver").PlayerRatingAccum>;
    const attacker = {
      id: 1, position: "DM" as const, deployedRole: "DM" as const, slotIndex: 3,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 1, zPace: 0, zPhysical: 0,
      zFinishing: 0, zGk: 0, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const defender = {
      id: 2, position: "CB" as const, deployedRole: "CB" as const, slotIndex: 2,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 0, zPace: 0, zPhysical: 0,
      zFinishing: 0, zGk: 0, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const attSide = {
      involved: [{ ps: attacker, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
      actionQuality: 0.5, defensiveResistance: 0,
    };
    const defSide = {
      involved: [{ ps: defender, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
      actionQuality: 0, defensiveResistance: 0.5,
    };
    const context: RatingDecisionInput = {
      phase: "PROGRESSION", zone: "MID_CENTRAL", possessionSide: 0, homeNeutral: true,
      stateValue: 0.1, possessionThreat: 0.1, homeClubId: 10, awayClubId: 20,
      sides: { home: attSide, away: defSide },
    };
    const observer = createRatingObserver({
      benchmarks: {
        GK: {}, FB: {}, CB: { tech: 0 }, MID: { tech: 0 }, FWD: {},
      } as import("../src/game/player-rating").RoleBenchmarks,
      fineRoleOf: (pid) => (pid === 1 ? "CM" : "CB"),
      base: accum,
    });
    // A resolved turnover: the attacker loses possession, the defender gains it.
    const probs = { CONTINUE: 0.7, TURNOVER: 0.2, FOUL: 0.05, RETAINED_RESTART: 0.05, action: "PASS" };
    observer.onDecision("outcome", context, probs, "TURNOVER", [1, 2]);

    const attackerAccum = accum[1];
    const defenderAccum = accum[2];
    expect(attackerAccum.rawImpact).toBeLessThan(0);
    expect(defenderAccum.rawImpact).toBeGreaterThan(0);
  });

  it("keeps routine CONTINUE outcomes to center the outcome sample", () => {
    const accum = {} as Record<number, import("../src/game/ratingObserver").PlayerRatingAccum>;
    const attacker = {
      id: 1, position: "DM" as const, deployedRole: "DM" as const, slotIndex: 3,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 1, zPace: 0, zPhysical: 0,
      zFinishing: 0, zGk: 0, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const defender = {
      id: 2, position: "CB" as const, deployedRole: "CB" as const, slotIndex: 2,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 0, zPace: 0, zPhysical: 0,
      zFinishing: 0, zGk: 0, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const attSide = {
      involved: [{ ps: attacker, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
      actionQuality: 0.5, defensiveResistance: 0,
    };
    const defSide = {
      involved: [{ ps: defender, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
      actionQuality: 0, defensiveResistance: 0.5,
    };
    const context: RatingDecisionInput = {
      phase: "PROGRESSION", zone: "MID_CENTRAL", possessionSide: 0, homeNeutral: true,
      stateValue: 0.1, possessionThreat: 0.1, homeClubId: 10, awayClubId: 20,
      sides: { home: attSide, away: defSide },
    };
    const observer = createRatingObserver({
      benchmarks: {
        GK: {}, FB: {}, CB: { tech: 0 }, MID: { tech: 0 }, FWD: {},
      } as import("../src/game/player-rating").RoleBenchmarks,
      fineRoleOf: (pid) => (pid === 1 ? "CM" : "CB"),
      base: accum,
    });

    observer.onDecision(
      "outcome",
      context,
      { CONTINUE: 0.7, TURNOVER: 0.2, FOUL: 0.05, RETAINED_RESTART: 0.05, action: "PASS" },
      "CONTINUE",
      [1, 2],
    );

    expect(accum[1]).toBeDefined();
    expect(accum[2]).toBeDefined();
    expect(accum[1].rawVariance).toBeGreaterThan(0);
    expect(accum[2].rawVariance).toBeGreaterThan(0);
  });

  it("scores a goal positively for the shooter and negatively for the goalkeeper", () => {
    const accum = {} as Record<number, import("../src/game/ratingObserver").PlayerRatingAccum>;
    const shooter = {
      id: 1, position: "ST" as const, deployedRole: "ST" as const, slotIndex: 9,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 0, zPace: 0, zPhysical: 0,
      zFinishing: 1, zGk: 0, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const gk = {
      id: 2, position: "GK" as const, deployedRole: "GK" as const, slotIndex: 0,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 0, zPace: 0, zPhysical: 0,
      zFinishing: 0, zGk: 1, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const attSide = {
      involved: [{ ps: shooter, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
    };
    const defSide = {
      involved: [{ ps: gk, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
      gk,
    };
    const context: RatingDecisionInput = {
      phase: "FINAL_THIRD", zone: "BOX", possessionSide: 0, homeNeutral: true,
      stateValue: 0.3, possessionThreat: 0.3, homeClubId: 10, awayClubId: 20,
      sides: { home: attSide, away: defSide },
    };
    const observer = createRatingObserver({
      benchmarks: {
        GK: { goalkeeping: 0 }, FB: {}, CB: {}, MID: {}, FWD: { finishing: 0 },
      } as import("../src/game/player-rating").RoleBenchmarks,
      fineRoleOf: (pid) => (pid === 1 ? "ST" : "GK"),
      base: accum,
    });
    // High-xG shot resolved as a goal.
    const probs = { GOAL: 0.6, SAVE: 0.25, BLOCK: 0.05, WOODWORK: 0.05, MISS: 0.05, zFinish: 1, zGk: 1, baselineXg: 0.6 };
    observer.onDecision("shot", context, probs, "GOAL", [1, 2]);

    expect(accum[1].rawImpact).toBeGreaterThan(0);
    expect(accum[2].rawImpact).toBeLessThan(0);
  });

  it("scores a penalty save strongly positive for the goalkeeper", () => {
    const accum = {} as Record<number, import("../src/game/ratingObserver").PlayerRatingAccum>;
    const shooter = {
      id: 1, position: "ST" as const, deployedRole: "ST" as const, slotIndex: 9,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 0, zPace: 0, zPhysical: 0,
      zFinishing: 0, zGk: 0, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const gk = {
      id: 2, position: "GK" as const, deployedRole: "GK" as const, slotIndex: 0,
      skills: { gol: 20, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 },
      overall: 60, age: 25, energy: 100, readiness: 1, onPitch: true,
      zTech: 0, zPace: 0, zPhysical: 0,
      zFinishing: 0, zGk: 0, zDefending: 0,
    } as import("../src/game/matchSim").LivePlayerState;
    const attSide = {
      involved: [{ ps: shooter, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
    };
    const defSide = {
      involved: [{ ps: gk, weight: 1 }], localDensity: 1, supportRatio: 1,
      coverageRatio: 1, readinessMean: 1, organisation: 1,
      tactics: { style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
      gk,
    };
    const context: RatingDecisionInput = {
      phase: "SET_PIECE", zone: "BOX", possessionSide: 0, homeNeutral: true,
      stateValue: 0.77, possessionThreat: 0.77, homeClubId: 10, awayClubId: 20,
      sides: { home: attSide, away: defSide },
    };
    const observer = createRatingObserver({
      benchmarks: {
        GK: { goalkeeping: 0 }, FB: {}, CB: {}, MID: {}, FWD: { finishing: 0 },
      } as import("../src/game/player-rating").RoleBenchmarks,
      fineRoleOf: (pid) => (pid === 1 ? "ST" : "GK"),
      base: accum,
    });
    // Penalty xG 0.77 saved: the goalkeeper's counterfactual makes this
    // strongly positive for him, and the miss strongly negative for the shooter.
    const probs = { GOAL: 0.77, SAVE: 0.15, BLOCK: 0.02, WOODWORK: 0.03, MISS: 0.03, zFinish: 0, zGk: 0, baselineXg: 0.77 };
    observer.onDecision("shot", context, probs, "SAVE", [1, 2]);

    expect(accum[2].rawImpact).toBeGreaterThan(0);
    expect(accum[1].rawImpact).toBeLessThan(0);
  });
});

describe("rating finalization", () => {
  /** One XI per side with enough roster for a bench (mirrors livePlayerStats). */
  function squads(): Player[] {
    return clonePlayers([...goldenSquad(1, 1, 31111, 1000), ...goldenSquad(2, 4, 32222, 2000)]);
  }

  it("computes ratings from the live observer, appends the MVP event (highest rating on the winning team) at final whistle, and credits the MVP count once", () => {
    const players = squads();
    const club = makeClub({ id: 1 });
    const world = makeWorld([club, makeClub({ id: 2 })], players, { humanClubId: 1 });
    const rng = createRng(777005);
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const st = createLiveMatchState(rng, home, away, players, {
      matchId: 700005,
      competitionId: 1,
      fixtureId: 700005,
      homeNeutral: true,
    });
    world.liveMatches.push(st);

    while (!st.ended) {
      const before = st.matchClockSeconds;
      tickLiveMatch(rng, home, away, players, st, 10, { resume: true });
      if (st.matchClockSeconds === before) break;
    }
    expect(st.ended).toBe(true);

    const match = finalizeLiveMatch(world, st)!;
    expect(match).not.toBeNull();

    const ratingRows = world.playerMatchRatings ?? [];
    expect(ratingRows.length).toBeGreaterThan(0);
    const ratedRows = ratingRows.filter((r) => r.ratingExact !== null);
    expect(ratedRows.length).toBeGreaterThan(0);
    for (const row of ratedRows) {
      expect(row.ratingExact!).toBeGreaterThanOrEqual(3);
      expect(row.ratingExact!).toBeLessThanOrEqual(10);
    }
    for (const row of ratingRows) {
      if (row.minutesPlayed < MIN_RATED_MINUTES) expect(row.ratingExact).toBeNull();
    }
    // Distribution sanity: ratings center near 6.5 with a healthy spread and
    // never saturate at 10 (regression for the benchmark/counterfactual bugs).
    const ratedValues = ratedRows.map((r) => r.ratingExact!);
    const avg = ratedValues.reduce((s, v) => s + v, 0) / ratedValues.length;
    expect(avg).toBeGreaterThan(5.5);
    expect(avg).toBeLessThan(7.5);
    expect(ratedValues.every((v) => v < 9.9)).toBe(true);
    // No NaN accumulators.
    for (const a of Object.values(st.ratingAccum ?? {})) {
      expect(Number.isFinite(a.rawImpact)).toBe(true);
      expect(Number.isFinite(a.rawVariance)).toBe(true);
    }
    // Regression: rating minutes = on-pitch match time (both sides, including
    // dead-ball). A player who stays on the whole match accumulates the full
    // match clock (~90' + stoppage); substitutes/substituted-off players show
    // less — and must NOT show ~1' for a full match.
    const clockMinutes = st.matchClockSeconds / 60;
    const fullMatchRows = ratingRows.filter((r) => r.minutesPlayed >= clockMinutes - 5);
    expect(fullMatchRows.length).toBeGreaterThanOrEqual(18);
    for (const row of fullMatchRows) {
      expect(row.minutesPlayed).toBeGreaterThanOrEqual(clockMinutes - 5);
    }

    const mvpEvents = match.events.filter((e) => e.type === EVENT_CODES.MVP);
    expect(mvpEvents).toHaveLength(1);
    const mvpRow = ratingRows.find((r) => r.playerId === mvpEvents[0].playerId)!;
    expect(mvpRow).toBeDefined();
    expect(match.mvpPlayerId).toBe(mvpRow.playerId);
    if (match.homeScore !== match.awayScore) {
      const winnerClub = match.homeScore > match.awayScore ? match.homeClubId : match.awayClubId;
      expect(mvpRow.clubId).toBe(winnerClub);
    }

    const mvpPlayer = players.find((p) => p.id === mvpRow.playerId)!;
    expect(mvpPlayer.careerMvps).toBe(1);
    expect(mvpPlayer.seasonMvps).toBe(1);

    expect(world.liveMatches).toHaveLength(0);
    expect(finalizeLiveMatch(world, st)).toBeNull();
  });

  it("selects the highest-rated player on the winning team as MVP from rows", () => {
    const match = {
      id: 1, homeClubId: 10, awayClubId: 20, homeScore: 2, awayScore: 1,
    } as Match;
    const rows: PlayerMatchRatingEntry[] = [
      row({ playerId: 11, clubId: 10, ratingExact: 7.1 }),
      row({ playerId: 12, clubId: 10, ratingExact: 8.4, primaryRole: "FWD", shootingImpact: 1 }),
      row({ playerId: 21, clubId: 20, ratingExact: 9.0 }),
    ];
    // Winning side is club 10; highest rated there is 12 (8.4), even though 21
    // (9.0) is higher overall but on the losing side.
    expect(mvpFromRatings(rows, match)).toEqual({ playerId: 12, clubId: 10 });
  });

  it("on a draw picks the highest-rated player from either side", () => {
    const match = { id: 1, homeClubId: 10, awayClubId: 20, homeScore: 1, awayScore: 1 } as Match;
    const rows: PlayerMatchRatingEntry[] = [
      row({ playerId: 11, clubId: 10, ratingExact: 6.8 }),
      row({ playerId: 21, clubId: 20, ratingExact: 7.5 }),
    ];
    expect(mvpFromRatings(rows, match)).toEqual({ playerId: 21, clubId: 20 });
  });

  it("does not award an MVP when no player reached the rating threshold", () => {
    const match = { id: 1, homeClubId: 10, awayClubId: 20, homeScore: 1, awayScore: 0 } as Match;
    const rows: PlayerMatchRatingEntry[] = [
      row({ playerId: 11, clubId: 10, ratingExact: null, minutesPlayed: 5 }),
    ];
    expect(mvpFromRatings(rows, match)).toBeNull();
  });

  it("primary role uses the role with the most seconds (coarse)", () => {
    const accum = {
      playerId: 1, clubId: 10,
      roleSeconds: { CM: 3000, ST: 2400 },
      rawImpact: 0, rawVariance: 0, categoryImpacts: {}, roleSecondsTotal: 5400,
    };
    expect(primaryCoarseRole(accum)).toBe("MID");
  });

  it("live rating is null before 10 match-minutes", () => {
    const accum = {
      playerId: 1, clubId: 10,
      roleSeconds: { CM: 300 },
      rawImpact: 0.2, rawVariance: 0.1, categoryImpacts: {}, roleSecondsTotal: 300,
    };
    expect(liveRatingFromAccum(accum, undefined)).toBeNull();
  });

  it("computeMatchRatingRows produces rows only for players with accumulators", () => {
    const match = { id: 7, homeClubId: 10, awayClubId: 20, homeScore: 1, awayScore: 0 } as Match;
    const players = clonePlayers([...goldenSquad(1, 1, 31111, 1000), ...goldenSquad(2, 4, 32222, 2000)]);
    const p0 = players[0];
    const rows = computeMatchRatingRows({
      match,
      seasonId: 1,
      tier: 1,
      calibration: undefined,
      accum: {
        [p0.id]: { playerId: p0.id, clubId: 10, roleSeconds: { CM: 5400 }, rawImpact: 0.5, rawVariance: 0.2, categoryImpacts: {}, roleSecondsTotal: 5400 },
      },
      players,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].minutesPlayed).toBe(90);
    expect(rows[0].ratingExact).not.toBeNull();
    expect(rows[0].ratingExact!).toBeGreaterThanOrEqual(3);
  });

  it("freezes the same-role benchmarks at kickoff and reuses them across ticks", () => {
    const players = squads();
    const rng = createRng(777006);
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const st = createLiveMatchState(rng, home, away, players, {
      matchId: 700006,
      competitionId: 1,
      fixtureId: 700006,
      homeNeutral: true,
    });

    // First tick snapshots the benchmarks onto the live state.
    const obs1 = ratingObserverFor(st, players);
    expect(obs1).not.toBeNull();
    expect(st.ratingBenchmarksJson).toBeDefined();

    // A resumed tick (simulating a server reload) must reuse the SAME frozen
    // snapshot, even if player slot assignments were to change.
    const players2 = clonePlayers(players);
    for (const p of players2) p.starter = false;
    const obs2 = ratingObserverFor(st, players2);
    expect(obs2).not.toBeNull();
    expect(st.ratingBenchmarksJson).toBeDefined();
    const snap = JSON.parse(st.ratingBenchmarksJson!);
    expect(typeof snap.DM.technique).toBe("number");
    expect(typeof snap.AM.technique).toBe("number");
    expect(typeof snap.GK.goalkeeping).toBe("number");
  });

  it("uses the durable match id and credits MVPs in instant division simulations", () => {
    const players = squads();
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const division: Competition = {
      id: 77, kind: "division", name: "1", round: 0, stage: "group", seasonId: 1, tier: 1, groupIndex: 0, status: "ACTIVE",
      config: { clubs: [1, 2], turns: 2, groups: [], bracket: [], promoted: 0, relegated: 0, groupQualifiers: 0 },
      standings: {}, groupStandings: [], winners: [], knockouts: [],
    };
    const world = makeWorld([home, away], players, {
      competitions: [division],
      fixtures: [{ id: 701, competitionId: division.id, round: 0, homeClubId: home.id, awayClubId: away.id, dayIndex: 0, played: false }],
      nextId: 9000,
    });

    simulateDivisionThroughRound(world, division, 1, Date.now());

    const match = world.matches.find((candidate) => candidate.fixtureId === 701)!;
    expect(match.id).toBe(9000);
    expect((world.playerMatchRatings ?? []).every((rating) => rating.matchId === match.id)).toBe(true);
    expect(match.mvpPlayerId).not.toBeNull();
    const mvp = world.players.find((player) => player.id === match.mvpPlayerId)!;
    expect(mvp.seasonMvps).toBe(1);
    expect(mvp.careerMvps).toBe(1);
  });

  it("builds score metadata from the rated match rather than placeholder values", () => {
    const playerId = 501;
    const world = makeWorld([makeClub({ id: 10 }), makeClub({ id: 20 })], [], {
      matches: [{
        id: 700, fixtureId: 701, competitionId: 1, homeClubId: 10, awayClubId: 20,
        homeScore: 2, awayScore: 1, penaltyWinnerId: null, stats: {} as Match["stats"], extraTime: false, minuteEvents: [],
        events: [
          { minute: 10, half: 1, type: EVENT_CODES.GOAL, subtype: 0, clubId: 10, playerId, player2Id: 502, goalType: 0 },
          { minute: 80, half: 2, type: EVENT_CODES.GOAL, subtype: 0, clubId: 10, playerId: 503, player2Id: playerId, goalType: 0 },
        ],
      }],
    });

    expect(playerMatchScoreView(world, row({ matchId: 700, playerId, clubId: 10 }))).toMatchObject({
      goals: 1, assists: 1, won: true, result: "2-1",
    });
  });
});
