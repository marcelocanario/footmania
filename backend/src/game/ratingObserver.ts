import type { MatchZone, LivePlayerState } from "./matchSim";
import type { MatchEvent } from "./types";
import { observeDecision } from "./player-rating";

/**
 * Read-only rating observer (plan §17). The match engine calls into this at
 * each probability decision, passing the probabilities it ALREADY computed
 * (plus context). The observer:
 *  - never mutates engine state;
 *  - never consumes RNG;
 *  - computes per-player counterfactual contributions via probabilityEval.ts.
 *
 * When no observer is installed (default), every hook is a no-op — so matches
 * with and without rating capture are byte-for-byte identical.
 */

export interface RatingDecisionContext {
  phase: string;
  zone: MatchZone;
  possessionSide: 0 | 1;
  homeNeutral: boolean;
  home: RatingSideView;
  away: RatingSideView;
  stateValue: number;
  minute: number;
}

export interface RatingSideView {
  involved: { ps: LivePlayerState; weight: number }[];
  localDensity: number;
  supportRatio: number;
  coverageRatio: number;
  readinessMean: number;
  organisation: number;
  tactics: { style: string; pressing: number; direction: string; familiarity: number };
  gk?: LivePlayerState;
}

/** Engine-side context the rating observer hook passes (read-only view of
 *  the engine at a decision). Defined here (the observer's contract) and
 *  consumed by player-rating.ts. */
export interface RatingDecisionInput {
  phase: string;
  zone: MatchZone;
  possessionSide: 0 | 1;
  homeNeutral: boolean;
  stateValue: number;
  homeClubId: number;
  awayClubId: number;
  /** EPV threat of the side that currently possesses the ball (0..1). */
  possessionThreat: number;
  sides: {
    home: EngineSideView;
    away: EngineSideView;
  };
}

export interface EngineSideView {
  involved: { ps: LivePlayerState; weight: number }[];
  localDensity: number;
  supportRatio: number;
  coverageRatio: number;
  readinessMean: number;
  organisation: number;
  tactics: { style: string; pressing: number; direction: string; familiarity: number };
  gk?: LivePlayerState;
  /** Engine-computed action-quality / defensive-resistance for the current
   *  action (captured at the decision; used as the non-substituted baseline). */
  actionQuality?: number;
  defensiveResistance?: number;
}

export interface RatingObserver {
  /** Per-decision capture. `probabilities` is the engine's normalized vector
   *  keyed by outcome label (may carry string metadata like the action);
   *  `resolved` is the label the engine drew. */
  onDecision(
    kind: "control-failure" | "intent" | "outcome" | "next-zone" | "shot" | "cards",
    ctx: RatingDecisionInput,
    probabilities: Record<string, number | string>,
    resolved: string,
    participants: number[],
  ): void;
  /** Per-tick on-pitch seconds (plan §17 §12): the rating-only seconds counter
   *  used for the 10-minute rule and role durations. Never read by gameplay. */
  onSeconds(seconds: Record<number, { seconds: number; fineRole: string }>): void;
}

/** A no-op observer: rating capture disabled (matches stay byte-identical). */
export const NULL_OBSERVER: RatingObserver = {
  onDecision: () => undefined,
  onSeconds: () => undefined,
};

/** Per-player live rating accumulator stored on LiveMatchState.ratingAccum. */
export interface PlayerRatingAccum {
  playerId: number;
  clubId: number;
  /** Seconds spent in each fine deployed role, keyed by DeployedRole. */
  roleSeconds: Record<string, number>;
  /** Σ c (excess contribution) and Σ v (variance) per category. */
  rawImpact: number;
  rawVariance: number;
  categoryImpacts: Record<string, number>;
  roleSecondsTotal: number;
}

export function emptyPlayerRatingAccum(playerId: number, clubId: number): PlayerRatingAccum {
  return {
    playerId,
    clubId,
    roleSeconds: {},
    rawImpact: 0,
    rawVariance: 0,
    categoryImpacts: {},
    roleSecondsTotal: 0,
  };
}

/** Merge a tick's accumulator into the persisted live state (idempotent:
 *  the engine rebuilds the accumulator fresh each tick from its own events,
 *  so we REPLACE per-player entries rather than sum — avoids double-counting
 *  across streamed ticks). */
export function mergeRatingAccum(base: Record<number, PlayerRatingAccum> | undefined, tick: Record<number, PlayerRatingAccum>): Record<number, PlayerRatingAccum> {
  const out = { ...(base ?? {}) };
  for (const [id, accum] of Object.entries(tick)) out[Number(id)] = accum;
  return out;
}

/** Finalize one player's accumulator into a persisted rating row shape. */
export function finalizePlayerRating(
  accum: PlayerRatingAccum,
  minutes: number,
  modelVersion: number,
  primaryRole: string,
): {
  rawImpact: number;
  rawVariance: number;
  rawZ: number;
  minutesPlayed: number;
  primaryRole: string;
  categoryImpacts: Record<string, number>;
  modelVersion: number;
} {
  const rawZ = accum.rawVariance > 0 ? accum.rawImpact / Math.sqrt(accum.rawVariance) : 0;
  return {
    rawImpact: accum.rawImpact,
    rawVariance: accum.rawVariance,
    rawZ,
    minutesPlayed: Math.round(minutes),
    primaryRole,
    categoryImpacts: { ...accum.categoryImpacts },
    modelVersion,
  };
}

/**
 * Concrete rating observer: implements `RatingObserver` over a per-player
 * accumulator using the pure math in player-rating.ts. Constructed once per
 * match (with the same-role benchmarks), fed by the engine's decision hooks.
 *
 * IMPORTANT: the observer must never throw into the engine. A failure in
 * rating math must not crash or alter a match, so every hook is wrapped.
 */
export interface RatingObserverOptions {
  benchmarks: import("./player-rating").RoleBenchmarks;
  fineRoleOf: (playerId: number) => string;
  /** Base accumulator (from the persisted live state). The observer reads the
   *  existing per-player entries and mutates them in place. */
  base?: Record<number, PlayerRatingAccum>;
}

export function createRatingObserver(opts: RatingObserverOptions): RatingObserver {
  // The accumulator lives in the live state (st.ratingAccum); the observer
  // reads/mutates those entries so streamed ticks and reloads accumulate.
  const live = opts.base ?? {};
  const accum = new Map<number, PlayerRatingAccum>();
  for (const [id, a] of Object.entries(live)) accum.set(Number(id), a);
  // Keep the map and the live object in sync: after each decision, write the
  // map back into the live object (cheap: only touched players).
  const flush = () => {
    for (const [id, a] of accum) live[id] = a;
  };

  return {
    onDecision(kind, ctx, probabilities, resolved, participants) {
      try {
        observeDecision(accum, ctx, opts.benchmarks, opts.fineRoleOf, kind, probabilities, resolved, participants, utilityFor(kind, ctx));
        flush();
      } catch {
        // Rating capture must never affect the match.
      }
    },
    onSeconds(seconds) {
      try {
        for (const [pid, entry] of Object.entries(seconds)) {
          const playerId = Number(pid);
          let a = accum.get(playerId);
          if (!a) {
            a = { playerId, clubId: 0, roleSeconds: {}, rawImpact: 0, rawVariance: 0, categoryImpacts: {}, roleSecondsTotal: 0 };
            accum.set(playerId, a);
          }
          a.roleSeconds[entry.fineRole] = (a.roleSeconds[entry.fineRole] ?? 0) + entry.seconds;
          a.roleSecondsTotal += entry.seconds;
        }
        flush();
      } catch {
        // Never affect the match.
      }
    },
  };

  /**
   * Perspective-aware utilities (Proposal A). Every outcome is valued from
   * the participating player's own team perspective, with the engine's actual
   * probability vector as the shared distribution:
   *  - the attacking participant values outcomes for the team in possession;
   *  - the defending participant values the same resolution from the
   *    opposition's perspective (winning possession is positive).
   * Values are symmetric around zero and bounded, so neither side dominates.
   */
  function utilityFor(kind: string, ctx: RatingDecisionInput): (outcome: string, isAttacker: boolean) => number {
    switch (kind) {
      // Shot distribution is always the attacker's. The goalkeeper's utility
      // mirrors it: saving/blocking/woodwork prevents a goal, conceding is the
      // worst outcome.
      case "shot": return (o, isAttacker) => {
        if (isAttacker) return o === "GOAL" ? 1 : o === "MISS" ? -1 : 0;
        return o === "GOAL" ? -1 : o === "SAVE" || o === "BLOCK" || o === "WOODWORK" ? 1 : 0;
      };
      case "outcome": return (o, isAttacker) => {
        // Possession is a zero-sum contest. CONTINUE has zero realized utility,
        // but remains in the centered expected-value calculation so routine
        // outcomes balance turnovers instead of being silently discarded.
        switch (o) {
          case "CONTINUE": return 0;
          case "TURNOVER": return isAttacker ? -1 : 1;
          case "FOUL": return isAttacker ? 0.2 : -0.2;
          case "RETAINED_RESTART": return isAttacker ? 0.2 : -0.2;
          default: return 0;
        }
      };
      case "control-failure": return () => 0;
      case "intent": case "next-zone": return () => 0;
      case "cards": return () => 0;
      default: return () => 0;
    }
  }
}

export type { MatchEvent };
