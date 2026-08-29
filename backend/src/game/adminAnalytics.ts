import type { Competition, Player, Position, World } from "./types";
import { divisionsInSeason, tierOf, groupIndexOf } from "./multiplayer";
import { totalDivisionsForGeneration, academyPositionWeights } from "./clubGenerator";
import { divisionMean, seniorPositionWeights } from "./playerGeneration";
import { getCommitmentTotals } from "./finance";
import { isEphemeralAI } from "./club";
import { seniorSurvivalWeights } from "./careerCurves";
import { calculateBaseSalary } from "./economy";
import { NATURAL_POSITION_ORDER, POSITION_GROUPS, groupRepresentative, positionGroup } from "./positions";
import { gameConfig } from "../config";

/**
 * Read-only world analytics for the admin panel (plan: admin analytics).
 *
 * Aggregates are derived exclusively from persisted state and the canonical
 * generation/balancing formulas — no new balance math lives here. Every
 * "projected"/"expected" figure below reuses the same equations that drive
 * player generation, academy intake sizing, and retirement, so real-vs-
 * projected deltas measure how the living world drifts from the design
 * expectation, not from an invented baseline.
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

  // --- Population count (real clubs only; excludes AI filler) -------------
  realSeniorCount: number;
  /** clubCount(real) x playerGenerationRules.initialSeniorSquadSize equilibrium target. */
  projectedSeniorCount: number;
  realYouthCount: number;
  /** clubCount(real) x playerGenerationRules.initialAcademySize equilibrium target. */
  projectedYouthCount: number;
  /** Real clubs whose senior squad is below the 20-player replacement floor. */
  clubsBelowSquadFloor: number;

  // --- Quality spread (diagnostic; no closed-form projected spread) -------
  overallStdDev: number | null;
  overallP10: number | null;
  overallP90: number | null;

  // --- AI filler staleness (fillers are static single-season rosters) -----
  fillerCount: number;
  fillerAvgOverall: number | null;
  /** Real (non-filler) clubs only; compare against fillerAvgOverall for drift. */
  humanAvgOverall: number | null;

  // --- Position/role balance vs the senior generation template (§13.6) ------
  /** Count per NATURAL position (GK/LB/RB/CB/DM/AM/LW/RW/ST). */
  positionCounts: Record<string, number>;
  /** real share - hierarchical target share (broadWeight × withinGroupWeight). */
  positionShareDelta: Record<string, number>;
  /** Count per derived BROAD group (GK/FB/CB/MF/FW). */
  broadPositionCounts: Record<string, number>;
  /** real share - senior broad-group target share, in [-1, 1]. */
  broadPositionShareDelta: Record<string, number>;

  // --- Economic drift -------------------------------------------------------
  /** mean(actualSalary / calculateBaseSalary(overall, age)) - 1; null when empty. */
  salaryDriftIndex: number | null;
}

export interface AgeBucketRow {
  label: string;
  realCount: number;
  realShare: number;
  /** Steady-state share under constant academy intake + live retirement odds. */
  projectedShare: number;
}

export interface PopulationFlowSummary {
  seasonId: number;
  seasonKey: string;
  retirees: number;
  promotions: number;
  seasonalIntakeGenerated: number;
  replacementsGenerated: number;
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
    realSeniorCount: number;
    projectedSeniorCount: number;
    realYouthCount: number;
    projectedYouthCount: number;
    clubsBelowSquadFloor: number;
    overallStdDev: number | null;
    salaryDriftIndex: number | null;
  };
  /** World-level standing-population age pyramid vs the steady-state projection. */
  ageDistribution: AgeBucketRow[];
  freeAgentPool: {
    activeCount: number;
    avgAge: number | null;
    avgOverall: number | null;
    avgListedValue: number | null;
  };
  population: {
    /** Most recent seasons first, one row per season (bounded history). */
    history: PopulationFlowSummary[];
    /** history[0] if it matches the current season, else null. */
    currentSeason: PopulationFlowSummary | null;
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function percentile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length))] ?? 0;
}

/** Active (non-archived) divisions of the season being played. */
function activeDivisions(world: World): Competition[] {
  return divisionsInSeason(world, world.mp.seasonId).filter((c) => c.status !== "ARCHIVED");
}

const AGE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "18-20", min: 18, max: 20 },
  { label: "21-23", min: 21, max: 23 },
  { label: "24-26", min: 24, max: 26 },
  { label: "27-29", min: 27, max: 29 },
  { label: "30-32", min: 30, max: 32 },
  { label: "33-35", min: 33, max: 35 },
  { label: "36-38", min: 36, max: 38 },
  { label: "39+", min: 39, max: 999 },
];

/**
 * Steady-state share of the standing senior population at each age, from the
 * SAME authoritative active-career survival model that initial senior age
 * generation and academy intake planning use. Real-vs-projected age deltas
 * therefore measure world drift, not a disagreement between two models.
 */
function equilibriumAgeShares(): { age: number; share: number }[] {
  const academyWeights = academyPositionWeights();
  const weightSum = academyWeights.reduce((sum, weight) => sum + weight, 0);
  const blended = new Map<number, number>();
  // §13.2: value/survival stays broad-group based, so each broad academy weight
  // pairs with its group's representative natural position.
  for (let index = 0; index < academyWeights.length; index++) {
    const share = academyWeights[index] / weightSum;
    for (const [age, weight] of seniorSurvivalWeights(groupRepresentative(POSITION_GROUPS[index]))) {
      blended.set(age, (blended.get(age) ?? 0) + share * weight);
    }
  }
  const total = [...blended.values()].reduce((sum, weight) => sum + weight, 0);
  return [...blended.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([age, weight]) => ({ age, share: total > 0 ? weight / total : 0 }));
}

function ageDistribution(world: World, realClubIds: Set<number>): AgeBucketRow[] {
  const seniors = world.players.filter((p) => p.clubId !== null && realClubIds.has(p.clubId) && !p.isYouth);
  const equilibrium = equilibriumAgeShares();
  return AGE_BUCKETS.map((bucket) => {
    const realCount = seniors.filter((p) => p.age >= bucket.min && p.age <= bucket.max).length;
    const projectedShare = equilibrium.filter((e) => e.age >= bucket.min && e.age <= bucket.max).reduce((sum, e) => sum + e.share, 0);
    return {
      label: bucket.label,
      realCount,
      realShare: seniors.length > 0 ? round4(realCount / seniors.length) : 0,
      projectedShare: round4(projectedShare),
    };
  });
}

function positionShares(players: Player[]): { natural: Record<string, number>; broad: Record<string, number> } {
  const natural: Record<string, number> = { GK: 0, LB: 0, RB: 0, CB: 0, DM: 0, AM: 0, LW: 0, RW: 0, ST: 0 };
  const broad: Record<string, number> = { GK: 0, FB: 0, CB: 0, MF: 0, FW: 0 };
  for (const p of players) {
    const pos = p.position as string;
    if (pos in natural) natural[pos]++;
    const g = positionGroup(p.position);
    broad[g]++;
  }
  return { natural, broad };
}

function salaryDriftIndex(players: Player[]): number | null {
  if (players.length === 0) return null;
  const ratios = players
    .map((p) => calculateBaseSalary(p.overall, p.age))
    .map((expected, i) => (expected > 0 ? players[i].salary / expected : null))
    .filter((r): r is number => r !== null);
  return ratios.length === 0 ? null : round4(mean(ratios) - 1);
}

export function divisionAnalytics(world: World): WorldAnalytics {
  const totalDivisions = totalDivisionsForGeneration(world);
  const rules = gameConfig.playerGenerationRules;
  // §13.6 targets: the broad target is the senior group weight; the natural
  // target is derived hierarchically as broadWeight × withinGroupWeight — never
  // flattened independently.
  const seniorWeights = seniorPositionWeights();
  const senWeightSum = seniorWeights.reduce((sum, weight) => sum + weight, 0);
  const broadTargetShare: Record<string, number> = {};
  const naturalTargetShare: Record<string, number> = {};
  {
    const { seniorGroups, withinGroup } = gameConfig.playerGeneration.positionMix;
    for (const group of POSITION_GROUPS) {
      const groupShare = seniorGroups[group] / senWeightSum;
      broadTargetShare[group] = groupShare;
      for (const [role, share] of Object.entries(withinGroup[group])) {
        naturalTargetShare[role] = groupShare * share;
      }
    }
  }
  const rows: DivisionAnalyticsRow[] = [];
  let seniorsTotal = 0;
  let overallSum = 0;
  let projectedWeightedSum = 0;
  let clubCount = 0;
  let humanCount = 0;
  let distressCount = 0;
  let realSeniorTotal = 0;
  let projectedSeniorTotal = 0;
  let realYouthTotal = 0;
  let projectedYouthTotal = 0;
  let clubsBelowFloorTotal = 0;
  const allRealSeniors: Player[] = [];

  for (const comp of activeDivisions(world)) {
    const memberIds = Object.keys(comp.standings).map(Number);
    const memberSet = new Set(memberIds);
    const members = memberIds
      .map((id) => world.clubs.find((club) => club.id === id))
      .filter((club): club is NonNullable<typeof club> => club !== undefined);
    const realMembers = members.filter((club) => !isEphemeralAI(club));
    const realMemberIds = new Set(realMembers.map((club) => club.id));
    const fillerMembers = members.filter((club) => isEphemeralAI(club));

    const seniors = world.players.filter((p) => p.clubId !== null && memberSet.has(p.clubId) && !p.isYouth);
    const realSeniors = seniors.filter((p) => realMemberIds.has(p.clubId!));
    const fillerSeniors = seniors.filter((p) => !realMemberIds.has(p.clubId!));
    const realYouth = world.players.filter((p) => p.clubId !== null && realMemberIds.has(p.clubId) && p.isYouth);

    const realAvg = seniors.length > 0 ? round2(seniors.reduce((sum, p) => sum + p.overall, 0) / seniors.length) : null;
    // One causal pathway: the projected mean comes only from the canonical
    // generation formula for this tier; nothing here feeds back into gameplay.
    const projected = round2(divisionMean(Math.max(1, tierOf(comp)), totalDivisions));
    const distress = members.filter(
      (club) => club.competitionState === "ACTIVE" && club.ownerUserId !== null && getCommitmentTotals(world, club).financialCushion < 0,
    ).length;

    const realOveralls = realSeniors.map((p) => p.overall).sort((a, b) => a - b);
    const clubsBelowFloor = realMembers.filter((club) => world.players.filter((p) => p.clubId === club.id && !p.isYouth).length < 20).length;

    // §13.6: report BOTH taxonomies, as separate records — merging them into
    // one flat map collides on the shared GK/CB keys and hides which target a
    // delta was measured against.
    const positionCounts = positionShares(realSeniors);
    const total = realSeniors.length;
    const broadShareDelta: Record<string, number> = {};
    for (const group of POSITION_GROUPS) {
      const realShare = total > 0 ? (positionCounts.broad[group] ?? 0) / total : 0;
      broadShareDelta[group] = round4(realShare - broadTargetShare[group]);
    }
    const naturalShareDelta: Record<string, number> = {};
    for (const role of NATURAL_POSITION_ORDER) {
      const realShare = total > 0 ? (positionCounts.natural[role] ?? 0) / total : 0;
      naturalShareDelta[role] = round4(realShare - (naturalTargetShare[role] ?? 0));
    }

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

      realSeniorCount: realSeniors.length,
      projectedSeniorCount: realMembers.length * rules.initialSeniorSquadSize,
      realYouthCount: realYouth.length,
      projectedYouthCount: realMembers.length * rules.initialAcademySize,
      clubsBelowSquadFloor: clubsBelowFloor,

      overallStdDev: realOveralls.length > 0 ? round2(stdDev(realOveralls)) : null,
      overallP10: realOveralls.length > 0 ? percentile(realOveralls, 0.1) : null,
      overallP90: realOveralls.length > 0 ? percentile(realOveralls, 0.9) : null,

      fillerCount: fillerMembers.length,
      fillerAvgOverall: fillerSeniors.length > 0 ? round2(mean(fillerSeniors.map((p) => p.overall))) : null,
      humanAvgOverall: realSeniors.length > 0 ? round2(mean(realSeniors.map((p) => p.overall))) : null,

      positionCounts: positionCounts.natural,
      positionShareDelta: naturalShareDelta,
      broadPositionCounts: positionCounts.broad,
      broadPositionShareDelta: broadShareDelta,

      salaryDriftIndex: salaryDriftIndex(realSeniors),
    });

    seniorsTotal += seniors.length;
    if (realAvg !== null) overallSum += realAvg * seniors.length;
    projectedWeightedSum += projected * Math.max(1, memberIds.length);
    clubCount += memberIds.length;
    humanCount += members.filter((club) => club.ownerUserId !== null).length;
    distressCount += distress;
    realSeniorTotal += realSeniors.length;
    projectedSeniorTotal += realMembers.length * rules.initialSeniorSquadSize;
    realYouthTotal += realYouth.length;
    projectedYouthTotal += realMembers.length * rules.initialAcademySize;
    clubsBelowFloorTotal += clubsBelowFloor;
    allRealSeniors.push(...realSeniors);
  }

  rows.sort((a, b) => a.tier - b.tier || a.groupIndex - b.groupIndex);

  const realClubIds = new Set(world.clubs.filter((club) => !isEphemeralAI(club)).map((club) => club.id));
  const activeListings = world.freeAgentListings.filter((listing) => listing.status === "ACTIVE");
  const listedPlayers = activeListings
    .map((listing) => ({ listing, player: world.players.find((p) => p.id === listing.playerId) }))
    .filter((entry): entry is { listing: (typeof activeListings)[number]; player: Player } => entry.player !== undefined);

  const history = [...(world.mp.populationHistory ?? [])]
    .sort((a, b) => b.seasonId - a.seasonId)
    .map((entry) => ({
      seasonId: entry.seasonId,
      seasonKey: entry.seasonKey,
      retirees: entry.retirees,
      promotions: entry.promotions,
      seasonalIntakeGenerated: entry.seasonalIntakeGenerated,
      replacementsGenerated: entry.replacementsGenerated,
    }));

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
      realSeniorCount: realSeniorTotal,
      projectedSeniorCount: projectedSeniorTotal,
      realYouthCount: realYouthTotal,
      projectedYouthCount: projectedYouthTotal,
      clubsBelowSquadFloor: clubsBelowFloorTotal,
      overallStdDev: allRealSeniors.length > 0 ? round2(stdDev(allRealSeniors.map((p) => p.overall))) : null,
      salaryDriftIndex: salaryDriftIndex(allRealSeniors),
    },
    ageDistribution: ageDistribution(world, realClubIds),
    freeAgentPool: {
      activeCount: listedPlayers.length,
      avgAge: listedPlayers.length > 0 ? round2(mean(listedPlayers.map((e) => e.player.age))) : null,
      avgOverall: listedPlayers.length > 0 ? round2(mean(listedPlayers.map((e) => e.player.overall))) : null,
      avgListedValue: listedPlayers.length > 0 ? round2(mean(listedPlayers.map((e) => e.listing.currentPrice))) : null,
    },
    population: {
      history,
      currentSeason: history[0]?.seasonId === world.mp.seasonId ? history[0] : null,
    },
  };
}