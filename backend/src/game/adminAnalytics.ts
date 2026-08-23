import type { Competition, World } from "./types";
import { divisionsInSeason, tierOf, groupIndexOf } from "./multiplayer";
import { totalDivisionsForGeneration } from "./clubGenerator";
import { divisionMean } from "./playerGeneration";
import { getCommitmentTotals } from "./finance";

/**
 * Read-only world analytics for the admin panel (plan: admin analytics).
 *
 * Aggregates are derived exclusively from persisted state and the canonical
 * generation formulas — no new balance math lives here. The "projected"
 * division quality is the same divisionMean(D, N) curve that drives player
 * generation (player-generation §10/§11), so the real-vs-projected delta
 * measures how actual squads drift from the design expectation.
 */

export interface DivisionAnalyticsRow {
  divisionId: number;
  name: string;
  tier: number;
  groupIndex: number;
  clubCount: number;
  humanCount: number;
  /** Mean overall across senior squad players in the division; null when empty. */
  realAvgOverall: number | null;
  /** Canonical divisionMean(tier, pyramidDepth) expectation for this tier. */
  projectedAvgOverall: number;
  /** real - projected; null when the division has no senior players. */
  deltaOverall: number | null;
  /** Active human clubs whose financial cushion is negative right now. */
  clubsInFinancialDistress: number;
}

export interface WorldAnalytics {
  seasonId: number;
  /** Pyramid depth fed into the projected-quality formula. */
  totalDivisions: number;
  divisions: DivisionAnalyticsRow[];
  summary: {
    divisionCount: number;
    clubCount: number;
    humanCount: number;
    /** Player-weighted mean senior overall across all reported divisions. */
    realAvgOverall: number | null;
    /** Squad-weighted mean of the per-division projected means. */
    projectedAvgOverall: number | null;
    clubsInFinancialDistress: number;
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Active (non-archived) divisions of the season being played. */
function activeDivisions(world: World): Competition[] {
  return divisionsInSeason(world, world.mp.seasonId).filter((c) => c.status !== "ARCHIVED");
}

export function divisionAnalytics(world: World): WorldAnalytics {
  const totalDivisions = totalDivisionsForGeneration(world);
  const rows: DivisionAnalyticsRow[] = [];
  let seniorsTotal = 0;
  let overallSum = 0;
  let projectedWeightedSum = 0;
  let clubCount = 0;
  let humanCount = 0;
  let distressCount = 0;

  for (const comp of activeDivisions(world)) {
    const memberIds = Object.keys(comp.standings).map(Number);
    const memberSet = new Set(memberIds);
    const members = memberIds
      .map((id) => world.clubs.find((club) => club.id === id))
      .filter((club): club is NonNullable<typeof club> => club !== undefined);
    const seniors = world.players.filter((p) => p.clubId !== null && memberSet.has(p.clubId) && !p.isYouth);
    const realAvg = seniors.length > 0 ? round2(seniors.reduce((sum, p) => sum + p.overall, 0) / seniors.length) : null;
    // One causal pathway: the projected mean comes only from the canonical
    // generation formula for this tier; nothing here feeds back into gameplay.
    const projected = round2(divisionMean(Math.max(1, tierOf(comp)), totalDivisions));
    const distress = members.filter(
      (club) => club.competitionState === "ACTIVE" && club.ownerUserId !== null && getCommitmentTotals(world, club).financialCushion < 0,
    ).length;

    rows.push({
      divisionId: comp.id,
      name: comp.name,
      tier: tierOf(comp),
      groupIndex: groupIndexOf(comp),
      clubCount: memberIds.length,
      humanCount: members.filter((club) => club.ownerUserId !== null).length,
      realAvgOverall: realAvg,
      projectedAvgOverall: projected,
      deltaOverall: realAvg === null ? null : round2(realAvg - projected),
      clubsInFinancialDistress: distress,
    });

    seniorsTotal += seniors.length;
    if (realAvg !== null) overallSum += realAvg * seniors.length;
    projectedWeightedSum += projected * Math.max(1, memberIds.length);
    clubCount += memberIds.length;
    humanCount += members.filter((club) => club.ownerUserId !== null).length;
    distressCount += distress;
  }

  rows.sort((a, b) => a.tier - b.tier || a.groupIndex - b.groupIndex);

  return {
    seasonId: world.mp.seasonId,
    totalDivisions,
    divisions: rows,
    summary: {
      divisionCount: rows.length,
      clubCount,
      humanCount,
      realAvgOverall: seniorsTotal > 0 ? round2(overallSum / seniorsTotal) : null,
      projectedAvgOverall: clubCount > 0 ? round2(projectedWeightedSum / clubCount) : null,
      clubsInFinancialDistress: distressCount,
    },
  };
}
