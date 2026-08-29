import type { Club, Player, World } from "./types";
import { chance } from "./rng";
import { aging, shouldRetire } from "./player";
import { DAYS_PER_YEAR, SENIOR_SQUAD_FLOOR } from "./constants";
import { ensureClubSquadNumbers } from "./squadNumbers";
import { gameConfig } from "../config";
import { resetPayrollPeriod, settlePayrollThrough, settlePlayerPayroll } from "./payroll";
import {
  calculatePlayerValue,
  calculateProfessionalContractSalary,
  calculateReleaseClause,
  remainingSeasons,
} from "./economy";
import { divisionForClub, lowestActiveTier } from "./multiplayer";
import { generateSeasonalAcademyIntake, academyIntakeDone, markAcademyIntakeDone } from "./clubGenerator";
import { bumpSkillsVersion } from "./skillsVersion";
import { generateSeniorPlayer, allocateBroadGroupCounts, allocateSeededCounts } from "./playerGeneration";
import { prepareFreeAgentListing } from "./freeAgents";
import { playerHasActiveListing } from "./market";
import { isEphemeralAI, seniorRosterFullError } from "./club";
import {
  activePersistentClubs,
  activePopulation,
  allocatedIntakeForClub,
  commitSeasonalIntake,
  ensurePopulationLedger,
  expectedEligibleRetirements,
  isActivePersistentClub,
  pendingYouthDismissalCount,
  planSeasonalIntake,
  recordExtraNonAcademyGeneration,
  recordRetirementOutcome,
  recordYouthDismissal,
  targetActivePopulation,
  type IntakePlan,
} from "./population";
import { NEWS_SUBJECTS, publishNews } from "./news";
import { NATURAL_POSITION_ORDER } from "./positions";

/** FNV-1a 32-bit hash (same authority as the seeded allocators in
 *  playerGeneration.ts; deterministic senior-floor tie rotation). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Add game-days without wrapping at a civil-month or season boundary. */
export function seasonEndDay(dayIndex: number, daysFromNow: number): number {
  return dayIndex + Math.max(0, daysFromNow);
}

export function calculateDivisionPrize(higherBudget: number, currentBudget: number, position: number, teamCount: number): number {
  if (position < 1 || teamCount < 1 || position > teamCount) return 0;
  const difference = Math.max(0, higherBudget - currentBudget);
  return Math.round(difference * ((teamCount - position + 1) / teamCount));
}

export function loanFitsContract(startDay: number, endDay: number, contractDays: number): boolean {
  return endDay > startDay && endDay - startDay <= contractDays;
}

export { SENIOR_SQUAD_LIMIT } from "./constants";

/**
 * Promote a youth player into the senior squad.
 *
 * Promotion is a STATUS CHANGE, not a negotiation. It accepts no contract term
 * and performs no salary calculation: the player's salary, contract start and
 * end boundaries, and remaining duration all carry over exactly. That is what
 * gives a lower-division club a real window to use an excellent homegrown
 * player on academy wages before a normal professional renewal turns it into a
 * genuine keep-or-sell decision — and why his release clause stays low.
 *
 * `reason: "age"` is the mandatory boundary promotion. It cannot be blocked by
 * the senior cap: it may create a temporary overflow rather than release, list,
 * replace, or overwrite anybody.
 */
export function promoteYouthPlayer(world: World, player: Player, reason: "manual" | "age" = "manual"): { ok: boolean; error?: string } {
  const club = world.clubs.find((c) => c.id === player.clubId);
  if (!club || !player.isYouth) return { ok: false, error: "Player is not in the youth academy" };
  if (reason === "manual") {
    const { academyVoluntaryPromotionAge } = gameConfig.playerGenerationRules;
    if (player.age < academyVoluntaryPromotionAge) {
      return { ok: false, error: `Players can only be promoted from age ${academyVoluntaryPromotionAge}` };
    }
    const rosterFull = seniorRosterFullError(world, club.id);
    if (rosterFull) return { ok: false, error: rosterFull };
  }

  settlePlayerPayroll(world, player);
  player.isYouth = false;
  resetPayrollPeriod(player, world.dayIndex);
  player.starter = false;
  player.starter = false;
  // Promoted youth need a squad number that no senior currently wears.
  ensureClubSquadNumbers(world, club.id);
  publishNews(world, {
    kind: "academy",
    subject: NEWS_SUBJECTS.academy,
    recipientClubId: club.id,
    headline: "Academy and squad movement",
    entries: [{
      key: `promote:${player.id}`,
      label: player.name,
      detail: reason === "age"
        ? `promoted from the academy at age ${player.age} on his existing terms`
        : "promoted from the academy to the senior squad on his existing terms",
    }],
  });
  return { ok: true };
}

export function dismissYouthPlayer(world: World, player: Player): { ok: boolean; error?: string } {
  const club = world.clubs.find((c) => c.id === player.clubId);
  if (!club || !player.isYouth) return { ok: false, error: "Player is not in the youth academy" };
  settlePlayerPayroll(world, player);
  world.players = world.players.filter((p) => p.id !== player.id);
  // A dismissal must not hand this club a replacement — now or next season —
  // but it must not permanently drain the world either. It becomes ONE extra
  // player in the GLOBAL pool at the very next seasonal intake, shared out by
  // the seeded allocation like every other recruit.
  recordYouthDismissal(world);
  publishNews(world, {
    kind: "academy",
    subject: NEWS_SUBJECTS.academy,
    recipientClubId: club.id,
    headline: "Academy and squad movement",
    entries: [{ key: `dismiss:${player.id}`, label: player.name, detail: "released from the youth academy" }],
  });
  return { ok: true };
}

/** Pays wages accrued since the previous payroll boundary. */
export function settlePayroll(rng: World["rng"], world: World) {
  settlePayrollThrough(world);
}

export function updateCareerRecords(world: World) {
  let top: Player | null = null;
  for (const p of world.players) {
    if (!top || p.careerGoals > top.careerGoals) top = p;
  }
  upsertRecord(world, "all_time_top_scorer", top?.careerGoals ?? 0, top?.name ?? "—");
  let topSeason: Player | null = null;
  for (const p of world.players) {
    if (!topSeason || p.seasonGoals > topSeason.seasonGoals) topSeason = p;
  }
  upsertRecord(world, "most_goals_in_season", topSeason?.seasonGoals ?? 0, topSeason?.name ?? "—");
  // Division titles are tracked per club in `trophies`, keyed by division name
  // (invariant #19). The all-time leader holds the record.
  let topClub: Club | null = null;
  let topCount = 0;
  for (const club of world.clubs) {
    const titles = Object.values(club.trophies).reduce((sum, count) => sum + count, 0);
    if (titles > topCount) {
      topCount = titles;
      topClub = club;
    }
  }
  upsertRecord(world, "most_league_titles", topCount, topClub?.name ?? "—");
}

function upsertRecord(world: World, category: string, value: number, holderName: string) {
  const existing = world.records.find((r) => r.category === category);
  if (existing) {
    if (value > existing.value) {
      existing.value = value;
      existing.holderName = holderName;
    }
  } else {
    world.records.push({ category, value, holderName });
  }
}

export function computeSeasonAwards(world: World) {
  const season = world.mp.seasonYear;
  // Only the divisions of the season being archived are eligible; archived
  // competitions from earlier seasons must never produce duplicate awards.
  const comps = world.competitions.filter((c) => c.kind === "division" && c.seasonId === world.mp.seasonId && c.status !== "ARCHIVED");
  // Award eligibility (config): a player must have appeared in at least this
  // share of his club's league games to win an individual award or make the
  // Best XI. Keeps bench warmers with high overall from beating productive
  // starters. ceil() so a fraction like 0.4 of 14 games requires 6 appearances.
  const minFraction = gameConfig.awards.minAppearanceFraction;
  for (const comp of comps) {
    const clubIds = new Set(comp.config.clubs);
    const clubGames = Math.max(0, (comp.config.clubs.length - 1) * gameConfig.league.turns);
    const minApps = Math.ceil(clubGames * minFraction);
    const players = world.players.filter((p) => p.clubId !== null && clubIds.has(p.clubId))
      .filter((p) => (p.seasonAppearances ?? 0) >= minApps);
    const scorers = [...players].sort((a, b) => b.seasonGoals - a.seasonGoals || b.seasonAssists - a.seasonAssists);
    const topScorer = scorers[0];
    if (topScorer && topScorer.seasonGoals > 0) {
      world.seasonAwards.push({
        season,
        category: "top_scorer",
        competitionId: comp.id,
        playerId: topScorer.id,
        clubId: topScorer.clubId,
        playerNameSnapshot: topScorer.name,
        detail: `${topScorer.seasonGoals} goals`,
      });
    }
    const assisters = [...players].sort((a, b) => b.seasonAssists - a.seasonAssists);
    const topAssister = assisters[0];
    if (topAssister && topAssister.seasonAssists > 0) {
      world.seasonAwards.push({
        season,
        category: "top_assists",
        competitionId: comp.id,
        playerId: topAssister.id,
        clubId: topAssister.clubId,
        playerNameSnapshot: topAssister.name,
        detail: `${topAssister.seasonAssists} assists`,
      });
    }
    let pot: Player | null = null;
    let potScore = -1;
    for (const p of players) {
      const score = p.overall + p.seasonGoals * 2 + p.seasonAssists;
      if (score > potScore) {
        potScore = score;
        pot = p;
      }
    }
    if (pot) {
      world.seasonAwards.push({
        season,
        category: "player_of_season",
        competitionId: comp.id,
        playerId: pot.id,
        clubId: pot.clubId,
        playerNameSnapshot: pot.name,
        detail: `Overall ${pot.overall}, ${pot.seasonGoals} goals, ${pot.seasonAssists} assists`,
      });
    }
    const pickBest = (position: string, count: number): Player[] => {
      const pool = players
        .filter((p) => p.position === position)
        .sort((a, b) => b.overall + b.seasonGoals * 2 - (a.overall + a.seasonGoals * 2));
      return pool.slice(0, count);
    };
    // §13.4: fixed 4-3-3 natural-position Best XI shape.
    const xi = [
      ...pickBest("GK", 1),
      ...pickBest("LB", 1),
      ...pickBest("RB", 1),
      ...pickBest("CB", 2),
      ...pickBest("DM", 1),
      ...pickBest("AM", 2),
      ...pickBest("LW", 1),
      ...pickBest("RW", 1),
      ...pickBest("ST", 1),
    ];
    if (xi.length > 0) {
      world.seasonAwards.push({
        season,
        category: "best_xi",
        competitionId: comp.id,
        playerId: null,
        clubId: null,
        playerNameSnapshot: null,
        // Structured entries (id + clubId + name) so the client can link each
        // member to his player card while he still exists in the world.
        detail: JSON.stringify(xi.map((p) => ({ id: p.id, clubId: p.clubId, name: p.name }))),
      });
    }
  }
}

/**
 * Weekly contract cycle. Human clubs only (invariant #28): ephemeral AI
 * squads never renew, expire or release players during their single season.
 * A human-club player whose contract clock reached zero leaves as a free
 * agent through the standard expiry transition.
 */
export function contractCycle(rng: World["rng"], world: World) {
  void rng;
  for (const player of [...world.players]) {
    if (player.clubId === null) continue;
    const club = world.clubs.find((c) => c.id === player.clubId);
    if (!club || club.competitionState !== "ACTIVE" || isEphemeralAI(club)) continue;
    if (player.isYouth || player.loanId !== null || playerHasActiveListing(world, player)) continue;
    if (player.contractDays <= 0) {
      processContractExpiry(world, player.id);
    }
  }
}

/**
 * Per-season salary a club must pay to renew this player for `futureCompleteSeasons`
 * complete seasons beyond the current one.
 *
 * Because this is a CLUB RENEWAL, the baseline is the greater of what the club
 * already pays and the market salary implied by his CURRENT overall — so a
 * renewal can never cut a player's wage, and a player who has improved a lot
 * since signing can no longer be kept on a stale cheap deal. A promoted academy
 * player keeps his academy rate only until this is invoked.
 */
export function contractDemand(player: Player, futureCompleteSeasons: number, currentSeasonFraction = 0): number {
  return calculateProfessionalContractSalary({
    currentOverall: player.overall,
    currentAge: player.age,
    futureCompleteSeasons,
    currentSeasonFraction,
    currentSalary: player.salary,
  });
}

/** Emit the ordinary player-facing warning for a contract nearing expiry. */
export function processContractWarning(world: World, playerId: number): void {
  const player = world.players.find((candidate) => candidate.id === playerId);
  const club = player?.clubId === null || player?.clubId === undefined ? undefined : world.clubs.find((candidate) => candidate.id === player.clubId);
  if (!player || !club || club.competitionState !== "ACTIVE" || player.contractDays <= 0 || player.contractDays > gameConfig.seasonDays * gameConfig.contractWarningSeasons) return;
  // Same-day warnings for the same club merge into one grouped message;
  // the per-player entry key keeps a retried warning from duplicating a row.
  publishNews(world, {
    kind: "contract",
    subject: NEWS_SUBJECTS.contractWarning,
    recipientClubId: club.id,
    headline: "Contracts entering their final stretch",
    entries: [{ key: `warn:${player.id}`, label: player.name, detail: `${player.contractDays} days remaining on his current deal` }],
  });
}

/** Expire one contract through the same domain transition used by the cycle. */
export function processContractExpiry(world: World, playerId: number): void {
  const player = world.players.find((candidate) => candidate.id === playerId);
  if (!player || player.contractDays > 0 || player.clubId === null) return;
  const club = world.clubs.find((candidate) => candidate.id === player.clubId);
  if (!club || club.competitionState !== "ACTIVE") return;
  if (player.loanId !== null && player.loanId !== undefined) {
    const loan = world.loans.find((candidate) => candidate.id === player.loanId);
    if (loan) endLoan(world, loan);
  }
  const prepared = player.isYouth
    ? null
    : prepareFreeAgentListing(world, player, { allowOwnedPlayer: true });
  if (prepared && !prepared.ok) throw new Error(`Could not create free-agent listing after contract expiry: ${prepared.error}`);
  player.clubId = null;
  player.contractDays = Math.max(1, Math.round(DAYS_PER_YEAR / 2));
  player.starter = false;
  player.starter = false;
  player.onSale = false;
  if (prepared && prepared.ok) world.freeAgentListings.push(prepared.listing);
  // Same-day expiries for the same club merge into one grouped message.
  publishNews(world, {
    kind: "contract",
    subject: NEWS_SUBJECTS.contractExpiry,
    recipientClubId: club.id,
    headline: "Contract expiries",
    entries: [{ key: `expire:${player.id}`, label: player.name, detail: `left ${club.name} as a free agent after his contract expired` }],
  });
}

export function endLoan(world: World, loan: { id: number; playerId: number; fromClubId: number; toClubId: number | null }) {
  const p = world.players.find((x) => x.id === loan.playerId);
  const full = world.loans.find((l) => l.id === loan.id);
  if (full) full.recalled = true;
  if (p) {
    if (p.clubId !== loan.fromClubId) {
      settlePlayerPayroll(world, p);
    }
    p.clubId = loan.fromClubId;
    p.loanId = null;
    p.starter = false;
  }
  const from = world.clubs.find((c) => c.id === loan.fromClubId);
  const to = loan.toClubId !== null ? world.clubs.find((c) => c.id === loan.toClubId) : null;
  if (p && from) {
    publishNews(world, {
      kind: "loan",
      subject: NEWS_SUBJECTS.loans,
      recipientClubId: from.id,
      headline: "Loan movements",
      entries: [{
        key: `loan:${loan.id}`,
        label: p.name,
        detail: to ? `returned to ${from.name} after his loan at ${to.name} ended` : `was removed from the loan list of ${from.name}`,
      }],
    });
  }
}

/** Apply season-end aging, salary settlement, retirements, and contract expiry. */
export function processSeasonEndContracts(rng: World["rng"], world: World): void {
  // The configured season can end between payroll intervals. Settle the
  // remainder before resetting the day counter so every player earns one full
  // season salary.
  settlePayrollThrough(world, gameConfig.seasonDays);
  for (const player of world.players) {
    const club = player.clubId !== null ? world.clubs.find((c) => c.id === player.clubId) : undefined;
    // Invariant #28: ephemeral AI squads are static single-season rosters.
    // Aging, value recalculation and retirement must not mutate or delete
    // players from a roster that stays fixed until wholesale replacement.
    if (club && isEphemeralAI(club)) continue;
    // A dormant club is frozen whole: its players do not age, so they also
    // cannot develop, decline, retire, or reach contract expiry while away.
    // Their clocks resume only when the club becomes active again.
    if (club && club.competitionState === "DORMANT") continue;
    aging(player);
    // Contracts elapse only for clubs participating in the season: provisional
    // clubs keep their contract time frozen too.
    if (player.contractDays > 0 && (!club || club.competitionState === "ACTIVE")) {
      player.contractDays = Math.max(0, player.contractDays - DAYS_PER_YEAR);
    }
    // Market value is recalculated as age / overall / contract change; the
    // contract salary is fixed and is never recalculated at rollover.
    player.value = calculatePlayerValue(player.overall, player.age, remainingSeasons(player.contractDays));
    player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
  }
  // Measured BEFORE any retirement roll: the realized count is compared against
  // this so an unusually high-retirement season is fully replenished and an
  // unusually low one creates no permanent surplus.
  const expectedRetirements = expectedEligibleRetirements(world);
  const retirees: number[] = [];
  for (const player of world.players) {
    if (player.clubId !== null && !player.isYouth) {
      const club = world.clubs.find((c) => c.id === player.clubId);
      // Invariant #28: filler players never retire out of their static
      // roster; the whole squad is replaced with the club at rollover.
      if (club && isEphemeralAI(club)) continue;
      if (club && club.competitionState === "DORMANT") continue;
      if (player.age >= 33 && chance(rng, 25)) {
        publishNews(world, {
          kind: "retirement",
          subject: NEWS_SUBJECTS.retirement,
          clubId: club?.id,
          headline: "Retirement announcements",
          entries: [{ key: `retire:${player.id}`, label: player.name, detail: `(${club?.name ?? ""}) announced this will be his last season` }],
        });
      }
      if (shouldRetire(rng, player)) {
        retirees.push(player.id);
      }
    }
  }
  world.players = world.players.filter((p) => !retirees.includes(p.id));
  // Carried to processSeasonalAcademyIntake (a separate rollover step/world
  // load) so the combined population snapshot can report retirees alongside
  // that step's promotions/intake/replacement counts.
  world.mp.pendingSeasonRetirees = retirees.length;
  recordRetirementOutcome(world, retirees.length, expectedRetirements);
}

/**
 * Run mandatory youth promotion, the single seasonal academy intake, and the
 * senior-floor replacement pass.
 *
 * This is the ONLY step that converts pending population compensation into new
 * players. The exact global integer total is resolved first, then expressed as
 * an equal per-club base plus a seeded-random remainder, so the realized total
 * matches the resolved figure exactly instead of drifting.
 */
export function processSeasonalAcademyIntake(rng: World["rng"], world: World): void {
  void rng;
  const seasonId = world.mp.seasonId;
  const { academyAutomaticPromotionAge } = gameConfig.playerGenerationRules;
  let promotions = 0;
  let seasonalIntakeGenerated = 0;
  let replacementsGenerated = 0;
  const plan = planSeasonalIntake(world, seasonId);
  // Per-club flow consumed by the preseason report at SEASON_ROLLOVER_COMMIT.
  const flowByClub: Record<string, { promotions: number; intake: number; replacements: number }> = {};
  for (const club of world.clubs) {
    // Ephemeral AI squads are static (invariant #28): no promotions, no
    // academy intake and no replacement generation for filler clubs. Dormant
    // clubs are frozen and sit outside the active population entirely.
    if (!isActivePersistentClub(club)) continue;
    const juniors = world.players.filter((p) => p.clubId === club.id && p.isYouth);
    let clubPromotions = 0;
    // Mandatory and atomic: it cannot be blocked by the senior cap and never
    // releases, lists, replaces or overwrites anyone. A full squad simply goes
    // into temporary overflow, which the manager resolves by selling, loaning
    // out or releasing.
    for (const junior of juniors.filter((p) => p.age >= academyAutomaticPromotionAge)) {
      const result = promoteYouthPlayer(world, junior, "age");
      if (result.ok) {
        promotions++;
        clubPromotions++;
      }
    }
    let clubIntake = 0;
    if (seasonId !== 0 && !academyIntakeDone(world, club.id, seasonId)) {
      const intake = generateSeasonalAcademyIntake({
        world,
        club,
        currentDivision: divisionForClub(world, club.id),
        highestDivisionReached: club.highestDivision,
        totalDivisions: Math.max(1, lowestActiveTier(world, seasonId)),
        seasonId,
        allocated: allocatedIntakeForClub(plan, club.id),
      });
      seasonalIntakeGenerated += intake.length;
      clubIntake = intake.length;
      markAcademyIntakeDone(world, club.id, seasonId);
    }
    const squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    let clubReplacements = 0;
    if (squad.length < SENIOR_SQUAD_FLOOR) {
      const division = divisionForClub(world, club.id);
      const totalDivisions = Math.max(1, lowestActiveTier(world, seasonId));
      for (let i = squad.length; i < SENIOR_SQUAD_FLOOR; i++) {
        // §11.4: fill the largest positive natural-role deficit instead of
        // always generating a legacy MF. Target = current lineup-purpose senior
        // count + 1; broad targets via largest-remainder, child split via the
        // seeded allocator with the exact senior-floor key.
        const current = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
        const targetSize = current.length + 1;
        const mix = (gameConfig as unknown as { playerGeneration?: { positionMix?: { seniorGroups?: Record<string, number>; withinGroup?: Record<string, Record<string, number>> } } })?.playerGeneration?.positionMix;
        const seniorGroups = mix?.seniorGroups ?? { GK: 0.1, FB: 0.14, CB: 0.18, MF: 0.32, FW: 0.26 };
        const withinGroup = mix?.withinGroup ?? { GK: { GK: 1 }, FB: { LB: 0.5, RB: 0.5 }, CB: { CB: 1 }, MF: { DM: 0.5, AM: 0.5 }, FW: { LW: 1 / 3, RW: 1 / 3, ST: 1 / 3 } };
        const broad = allocateBroadGroupCounts(targetSize, seniorGroups);
        const seedKey = `${world.seed}|${club.id}|${seasonId ?? "none"}|senior-floor|${targetSize}|split|`;
        const currentCounts: Record<string, number> = { GK: 0, LB: 0, RB: 0, CB: 0, DM: 0, AM: 0, LW: 0, RW: 0, ST: 0 };
        for (const p of current) {
          const pos = p.position as string;
          if (pos in currentCounts) currentCounts[pos]++;
        }
        const targets: Record<string, number> = {};
        for (const [group, count] of Object.entries(broad)) {
          const split = allocateSeededCounts(count, withinGroup[group] ?? {}, `${seedKey}${group}`);
          for (const [role, n] of Object.entries(split)) targets[role] = (targets[role] ?? 0) + n;
        }
        // Deficit per role; largest positive deficit wins, tie by canonical
        // natural-position display order rotated by FNV-1a of the slot key.
        // §11.4 step 6: ties break by canonical display order ROTATED by one
        // hash of the slot key, so no role is permanently favoured.
        const rotation = fnv1a(`${world.seed}|${club.id}|${seasonId ?? "none"}|senior-floor|slot`) % NATURAL_POSITION_ORDER.length;
        const rotated = NATURAL_POSITION_ORDER.map(
          (_, i) => NATURAL_POSITION_ORDER[(i + rotation) % NATURAL_POSITION_ORDER.length],
        );
        let bestRole: string | null = null;
        let bestDeficit = -Infinity;
        for (const role of rotated) {
          const deficit = (targets[role] ?? 0) - (currentCounts[role] ?? 0);
          if (deficit > bestDeficit) {
            bestDeficit = deficit;
            bestRole = role;
          }
        }
        const position = (bestRole ?? "DM") as import("./positions").NaturalPosition;
        const p = generateSeniorPlayer({
          id: world.nextId++,
          clubId: club.id,
          country: club.country,
          position,
          isYouth: false,
          currentDivision: division,
          highestDivisionReached: club.highestDivision,
          totalDivisions,
          seasonId,
          generationType: "replacement",
          seed: world.seed,
          slot: i,
        });
        resetPayrollPeriod(p, world.dayIndex);
        world.players.push(p);
        bumpSkillsVersion();
        replacementsGenerated++;
        clubReplacements++;
      }
    }
    flowByClub[String(club.id)] = { promotions: clubPromotions, intake: clubIntake, replacements: clubReplacements };
  }
  commitSeasonalIntake(world, seasonId, plan, seasonalIntakeGenerated);
  // Recorded AFTER the commit that clears the consumed counters: replacements
  // created during this step are non-academy persistent generation and must
  // reduce the NEXT cycle's correction, not the one just settled.
  recordExtraNonAcademyGeneration(world, replacementsGenerated, "seniorFloorReplacements");
  world.mp.pendingPreseasonFlow = flowByClub;
  recordPopulationSnapshot(world, { promotions, seasonalIntakeGenerated, replacementsGenerated, plan });
}

/**
 * Record one population stock-and-flow snapshot per season for admin
 * analytics (retirees carried from processSeasonEndContracts alongside this
 * step's promotions/intake/replacements). Idempotent per season so a retried
 * step cannot duplicate an entry.
 */
function recordPopulationSnapshot(
  world: World,
  flow: { promotions: number; seasonalIntakeGenerated: number; replacementsGenerated: number; plan: IntakePlan },
): void {
  const seasonId = world.mp.seasonId;
  world.mp.populationHistory ??= [];
  if (world.mp.populationHistory.some((entry) => entry.seasonId === seasonId)) return;
  const activeClubIds = new Set(activePersistentClubs(world).map((c) => c.id));
  const seniors = world.players.filter((p) => p.clubId !== null && activeClubIds.has(p.clubId) && !p.isYouth);
  const youth = world.players.filter((p) => p.clubId !== null && activeClubIds.has(p.clubId) && p.isYouth);
  const stock = activePopulation(world);
  const ledger = ensurePopulationLedger(world);
  world.mp.populationHistory.push({
    seasonId,
    seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
    recordedAt: Date.now(),
    clubCount: activeClubIds.size,
    seniorCount: seniors.length,
    youthCount: youth.length,
    freeAgentCount: stock.freeAgents,
    targetActivePopulation: Math.round(targetActivePopulation(activeClubIds.size) * 100) / 100,
    meanAge: seniors.length > 0 ? Math.round((seniors.reduce((sum, p) => sum + p.age, 0) / seniors.length) * 100) / 100 : 0,
    meanOverall: seniors.length > 0 ? Math.round((seniors.reduce((sum, p) => sum + p.overall, 0) / seniors.length) * 100) / 100 : 0,
    retirees: world.mp.pendingSeasonRetirees ?? 0,
    expectedRetirees: Math.round(((world.mp.pendingSeasonRetirees ?? 0) - flow.plan.retirementVarianceCorrection) * 100) / 100,
    terminalDeletions: ledger.cumulative.eligibleTerminalDeletions ?? 0,
    promotions: flow.promotions,
    seasonalIntakeGenerated: flow.seasonalIntakeGenerated,
    replacementsGenerated: flow.replacementsGenerated,
    rawExpectedGlobalIntake: Math.round(flow.plan.rawExpectedGlobalIntake * 100) / 100,
    minimumGlobalIntake: flow.plan.minimumGlobalIntake,
    resolvedGlobalIntake: flow.plan.resolvedGlobalIntake,
    correctionCarriedForward: Math.round(ledger.carriedCorrection * 100) / 100,
    pendingYouthDismissals: pendingYouthDismissalCount(world),
  });
  world.mp.pendingSeasonRetirees = null;
  // Bounded history: keep the most recent seasons only.
  if (world.mp.populationHistory.length > 200) world.mp.populationHistory.splice(0, world.mp.populationHistory.length - 200);
}

/** Commit the new season's player-facing reset after all workflow steps pass. */
export function commitSeasonRollover(world: World): void {
  world.year += 1;
  world.dayIndex = 0;
  world.dayOfWeek = 0;
  for (const player of world.players) resetPayrollPeriod(player, 0);
  // Season structure (fixtures, standings reset, promotions) is owned by the
  // multiplayer engine during season rollover, not here.
  world.matches = [];
  // Multiplayer auctions use absolute deadlines and may legitimately cross a
  // month boundary. Keep all listings alive; the worker settles timestamped
  // listings, while legacy rows continue through the day-based compatibility
  // path.
  const academyNews = world.news
    .filter((item) => item.kind === "academy")
    .map((item) => ({ ...item, dayIndex: 0 }));
  world.news = academyNews;
  for (const player of world.players) {
    player.seasonGoals = 0;
    player.seasonAssists = 0;
    player.seasonAppearances = 0;
    player.yellows = 0;
    player.reds = 0;
    // Per-turn accumulation is season-scoped by construction, but clear it
    // explicitly so the new season starts from a clean slate.
    player.turnYellows = 0;
    player.yellowsTurnKey = null;
    player.onSale = world.transferAuctions.some((listing) => listing.status === "ACTIVE" && listing.playerId === player.id)
      || world.freeAgentListings.some((listing) => listing.status === "ACTIVE" && listing.playerId === player.id);
  }
}
