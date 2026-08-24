import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";

/**
 * Additional per-player work required to cover a short-handed side.
 *
 * Football effects such as possession, chance creation and defensive coverage
 * remain role- and zone-driven in matchSim's formation-support model. This
 * helper models only the separate compensatory workload documented for teams
 * reduced to ten players. It never changes score or win probability directly.
 */
export function remainingPlayerWorkloadMultiplier(onPitchCount: number): number {
  const cfg = MS.numericalDisadvantage;
  const available = Math.max(1, Math.trunc(onPitchCount));
  if (available >= cfg.referencePlayers) return 1;
  const multiplier = (cfg.referencePlayers / available) ** cfg.remainingPlayerWorkloadExponent;
  return Math.min(cfg.maxRemainingPlayerWorkloadMultiplier, Math.max(1, multiplier));
}
