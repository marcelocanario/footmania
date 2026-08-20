import { MARKET_CONFIG, gameConfig } from "../config";
import type { Club, FreeAgentListing, Player, TransferAuction, World } from "./types";
import { applyMaxBid, clubTransferCapMultiplier, createTransferAuction } from "./market";
import { applyFreeAgentBid } from "./freeAgents";
import { aiAffordableCommitment, getFinancialCushion } from "./finance";
import { positionCount } from "./club";
import { createRng, nextDouble } from "./rng";
import { divisionForClub, lowestActiveTier } from "./multiplayer";

/**
 * AI Selling (transfer-market-overhaul Phase 5, §35-§40).
 *
 * The AI *decides* (squad evaluation → sell score → binary list/keep); the
 * market service *executes* (createTransferAuction). This module never touches
 * hidden information: no `potential`, no `developmentProfile`, no star flag,
 * no reputation (§37/§38).
 *
 * The decision is binary (§39): "Would I accept the possibility that this
 * player sells at the generated opening bid?" If yes → public auction; if no →
 * keep. The marketplace decides the actual sale price.
 *
 * Market opportunity (§40) nudges borderline players onto the market but can
 * never override serious squad-depth problems: the "only adequate player at a
 * position" and "position already thin" penalties dominate (§93).
 */

/** The maximum number of senior players a club keeps per position (oversize). */
const DESIRED_SENIOR_SQUAD_SIZE = MARKET_CONFIG.aiSelling.desiredSeniorSquadSize;

/** The per-position "adequate" replacement floor for depth protection. */
const DEPTH_REPLACEMENT_FLOOR = MARKET_CONFIG.aiSelling.depthReplacementOverallFloor;

export interface SellScoreInputs {
  world: World;
  club: Club;
  player: Player;
  /** Active transfer-auction listings at the player's position. */
  activeListingsAtPosition: number;
  /** Clubs that currently have a positional need at this player's position. */
  clubsWithNeedAtPosition: number;
}

export interface SellScoreResult {
  score: number;
  /** Human-readable reasons for tests/debugging. */
  reasons: string[];
  /**
   * When true the AI would accept selling this player at the generated
   * opening bid (§39) — the binary decision that creates a public auction.
   */
  shouldList: boolean;
}

/**
 * Calculate the sell score for a single player (§36). Higher = more likely to
 * be listed. The threshold for listing is `listThreshold`.
 *
 * Only visible/current data is used:
 *   - positional surplus / depth from the current squad;
 *   - starter/backup role;
 *   - age and whether a replacement of similar ability exists;
 *   - contract situation;
 *   - salary vs value efficiency;
 *   - squad size vs the senior limit;
 *   - the club's cash vs payroll (financial pressure);
 *   - market liquidity/opportunity at this position.
 */
export function calculateSellScore(inputs: SellScoreInputs): SellScoreResult {
  const { world, club, player, activeListingsAtPosition, clubsWithNeedAtPosition } = inputs;
  const cfg = MARKET_CONFIG.aiSelling.sellScore;
  const reasons: string[] = [];

  let score = 0;

  // --- Squad depth at this position (§36: surplus, backup, thin) ---
  // Count eligible senior (non-youth) players at this position excluding the
  // player being evaluated.
  const samePosition = world.players.filter(
    (p) => p.clubId === club.id && !p.isYouth && p.position === player.position && p.id !== player.id
  );
  const otherAtPosition = samePosition.length;
  const backupOrBetter = samePosition.filter((p) => p.overall >= DEPTH_REPLACEMENT_FLOOR);

  if (otherAtPosition >= 2) {
    // Meaningful surplus: 2+ other senior players at the same position.
    score += cfg.surplusAtPosition;
    reasons.push(`surplus(${otherAtPosition}+others)`);
  } else if (otherAtPosition === 1) {
    // A single other player covers the position (backup / rarely needed).
    if (backupOrBetter.length > 0) {
      score += cfg.backupRarelyNeeded;
      reasons.push("backup");
    } else {
      // The only other player is weak; selling could hurt depth.
      score += cfg.positionThinPenalty;
      reasons.push("only-weak-backup");
    }
  } else {
    // Nobody else at this position.
    score += cfg.onlyAdequatePlayerPenalty;
    score += cfg.positionThinPenalty;
    reasons.push("only-player-at-position");
  }

  // --- Ageing with replacement (§36) ---
  if (player.age >= MARKET_CONFIG.aiSelling.ageingSellAge && backupOrBetter.length > 0) {
    score += cfg.olderWithReplacement;
    reasons.push("ageing+replacement");
  }

  // --- Starter importance (§36) ---
  if (player.starter) {
    score += cfg.primaryStarterPenalty;
    reasons.push("starter");
  }

  // --- Contract situation (§36) ---
  // The AI treats a contract as "nearing expiry" when it is inside the same
  // warning window used for contract-renewal prompts.
  const warningThreshold = gameConfig.seasonDays * gameConfig.contractWarningSeasons;
  const contractAlmostUp = player.contractDays > 0 && player.contractDays <= warningThreshold;
  if (contractAlmostUp) {
    score += cfg.contractNearingExpiry;
    reasons.push("contract-near-expiry");
  }

  // --- Salary/value efficiency (§36) ---
  // Poor wage efficiency: salary is high relative to value.
  if (player.value > 0) {
    const salaryToValueRatio = player.salary / player.value;
    if (salaryToValueRatio > MARKET_CONFIG.aiSelling.poorWageEfficiencySalaryToValueRatio) {
      score += cfg.poorWageEfficiency;
      reasons.push("poor-wage-efficiency");
    }
  }

  // --- Oversized squad (§36) ---
  const seniorCount = world.players.filter((p) => p.clubId === club.id && !p.isYouth).length;
  if (seniorCount > DESIRED_SENIOR_SQUAD_SIZE) {
    score += cfg.squadAboveDesiredSize;
    reasons.push("oversized-squad");
  }

  // --- Financial pressure (§36, financial-control §16) ---
  // The existing sell signal can use the FinancialCushion directly: a negative
  // cushion means known bids + salaries exceed cash, pushing the AI to sell.
  const cushion = getFinancialCushion(world, club);
  if (cushion < 0) {
    score += cfg.financialPressure;
    reasons.push("financial-pressure");
  }

  // --- Market opportunity (§40) ---
  // Few players available at this position, several clubs need it, and the
  // seller has excess depth => nudge toward listing. Must not override
  // serious depth problems, so only add when we already have surplus/backup.
  if (
    otherAtPosition >= 1 &&
    activeListingsAtPosition <= MARKET_CONFIG.aiSelling.marketOpportunityMaxActiveListings &&
    clubsWithNeedAtPosition >= MARKET_CONFIG.aiSelling.marketOpportunityMinNeedyClubs
  ) {
    score += cfg.marketOpportunity;
    reasons.push("market-opportunity");
  }

  const shouldList = score >= MARKET_CONFIG.aiSelling.listThreshold;
  return { score, reasons, shouldList };
}

export interface AiSellDecision {
  player: Player;
  score: number;
  reasons: string[];
}

/**
 * Evaluate an AI club's senior squad and rank players by sell score.
 * Never suggests youth players, players already on sale, players on loan,
 * players cooling down, or the sole adequate player at a position.
 */
export function evaluateSquadForSelling(
  world: World,
  club: Club
): AiSellDecision[] {
  const roster = world.players.filter((p) => p.clubId === club.id && !p.isYouth && !p.onSale && p.loanId === null);

  // Market-opportunity inputs: how many active listings at this position and
  // how many clubs currently have a positional need at it.
  const activeAtPosition = (pos: number) =>
    world.transferAuctions.filter((a) => {
      if (a.status !== "ACTIVE") return false;
      const p = world.players.find((x) => x.id === a.playerId);
      return p?.position === pos;
    }).length;

  const needsAtPosition = (pos: number) => {
    let need = 0;
    const minPerPosition = MARKET_CONFIG.aiSelling.minPerPosition;
    for (const c of world.clubs) {
      if (c.id === club.id || humanControlled(c)) continue;
      const cCounts = positionCount(c, world.players);
      if (cCounts[pos] < (minPerPosition[pos] ?? 2)) need++;
    }
    return need;
  };

  const decisions: AiSellDecision[] = [];
  for (const player of roster) {
    // Protect depth: if this is the only senior player at the position, never
    // suggest it regardless of market opportunity (§93).
    const othersAtPosition = roster.filter((p) => p.id !== player.id && p.position === player.position);
    if (othersAtPosition.length === 0) {
      continue;
    }

    const result = calculateSellScore({
      world,
      club,
      player,
      activeListingsAtPosition: activeAtPosition(player.position),
      clubsWithNeedAtPosition: needsAtPosition(player.position),
    });
    if (result.shouldList) {
      decisions.push({ player, score: result.score, reasons: result.reasons });
    }
  }

  // Rank by score descending (highest urgency first).
  return decisions.sort((a, b) => b.score - a.score);
}

function humanControlled(club: Club): boolean {
  return club.isHuman || club.ownerUserId !== null;
}

/**
 * The AI selling decision entry point (§39): for each candidate that passed
 * squad evaluation, create a public auction. Returns the list of listings
 * created. Idempotent: `createTransferAuction` rejects players already listed,
 * cooling down, youth, etc.
 */
export function aiSellSurplus(
  world: World,
  club: Club,
  opts: { sellerDivision: number; totalDivisions: number; now?: number; seasonRolloverAt?: number }
): TransferAuctionCreated[] {
  const candidates = evaluateSquadForSelling(world, club);
  const created: TransferAuctionCreated[] = [];
  const maxListings = MARKET_CONFIG.aiSelling.maxListingsPerClub;
  for (const candidate of candidates.slice(0, maxListings)) {
    const result = createTransferAuction(world, {
      player: candidate.player,
      sellerClub: club,
      sellerDivision: opts.sellerDivision,
      totalDivisions: opts.totalDivisions,
      now: opts.now,
      seasonRolloverAt: opts.seasonRolloverAt,
    });
    if (result.ok) {
      created.push({
        playerId: candidate.player.id,
        listingId: result.listing.id,
        score: candidate.score,
        reasons: candidate.reasons,
      });
    }
  }
  return created;
}

export interface TransferAuctionCreated {
  playerId: number;
  listingId: number;
  score: number;
  reasons: string[];
}

/**
 * Run AI selling across a slice of AI clubs. `divisionByClub` maps clubId →
 * division number (1 = strongest); `totalDivisions` is the pyramid depth
 * (computed by the caller, which may need prisma).
 *
 * The slice is chosen deterministically from the current wall-clock bucket so
 * consecutive worker ticks rotate fairly across all AI clubs without persisting
 * any cursor state (§102.5 durability rule — stateless is restart-safe).
 * `now` drives the bucket; pass the same `now` the caller used for listing
 * creation so the bucket matches the actual run instant.
 */
export function runAiSelling(
  world: World,
  opts: {
    divisionByClub: Map<number, number>;
    totalDivisions: number;
    now?: number;
    seasonRolloverAt?: number;
    maxClubs?: number;
  }
): TransferAuctionCreated[] {
  const allCreated: TransferAuctionCreated[] = [];
  const candidates = world.clubs
    .filter((c) => !humanControlled(c) && c.competitionState === "ACTIVE")
    .sort((a, b) => a.id - b.id);
  const maxClubs = opts.maxClubs ?? MARKET_CONFIG.aiSelling.clubsPerTick;
  if (candidates.length === 0) return allCreated;

  const now = opts.now ?? Date.now();
  // Deterministic rotation: each evaluation bucket starts at a different club.
  const bucket = Math.floor(now / (MARKET_CONFIG.aiSelling.evaluationIntervalMinutes * 60_000));
  const start = bucket % candidates.length;

  // maxClubs <= 0 means "evaluate every AI club this tick".
  const clubsToRun = maxClubs > 0 ? Math.min(maxClubs, candidates.length) : candidates.length;
  let clubsTried = 0;
  for (let i = 0; i < candidates.length && clubsTried < clubsToRun; i++) {
    const club = candidates[(start + i) % candidates.length];
    clubsTried += 1;
    const division = opts.divisionByClub.get(club.id);
    if (division === undefined || division <= 0) continue;
    const created = aiSellSurplus(world, club, {
      sellerDivision: division,
      totalDivisions: opts.totalDivisions,
      now,
      seasonRolloverAt: opts.seasonRolloverAt,
    });
    allCreated.push(...created);
  }
  return allCreated;
}
// ---------------------------------------------------------------------------
// AI Buying (§28-§34)
// ---------------------------------------------------------------------------

/**
 * Position need score (§28). Higher = the club genuinely needs a player at this
 * position. Uses only visible squad data (senior players, current overalls,
 * starters). Does not use hidden potential/development (§37/§38).
 */
export function positionNeedScore(club: Club, players: Player[], position: number): number {
  const cfg = MARKET_CONFIG.aiBuying.needScore;
  const atPosition = players.filter((p) => p.clubId === club.id && !p.isYouth && p.position === position);
  const adequate = atPosition.filter((p) => p.overall >= MARKET_CONFIG.aiBuying.adequateOverallFloor);
  const starter = atPosition.find((p) => p.starter);

  let score = 0;
  const reasons: string[] = [];

  if (adequate.length === 0) {
    score += cfg.noViableStarter;
    reasons.push("no-viable-starter");
  } else if (starter && starter.overall < MARKET_CONFIG.aiBuying.adequateOverallFloor + MARKET_CONFIG.aiBuying.starterBelowDesiredOffset) {
    score += cfg.starterBelowDesired;
    reasons.push("starter-below-desired");
  }

  const desired = MARKET_CONFIG.aiBuying.desiredDepthPerPosition[position] ?? 2;
  if (adequate.length < desired) {
    score += cfg.belowRequiredDepth;
    reasons.push("below-required-depth");
  } else if (adequate.length >= desired + MARKET_CONFIG.aiBuying.alreadyStrongSurplus) {
    score += cfg.alreadyStrong;
    reasons.push("already-strong");
  }

  const backup = atPosition.filter((p) => !p.starter && p.overall < MARKET_CONFIG.aiBuying.adequateOverallFloor);
  if (atPosition.length >= 2 && backup.length >= 1 && atPosition.some((p) => p.starter)) {
    score += cfg.weakBackup;
    reasons.push("weak-backup");
  }

  if (starter && starter.age >= MARKET_CONFIG.aiBuying.ageingBuyAge) {
    score += cfg.ageingStarter;
    reasons.push("ageing-starter");
  }

  return score;
}

/**
 * Upgrade gain (§29). How much this player improves the club at his position,
 * using only visible data: his overall vs the current best at the position.
 * Floored at 1 — a worse player simply doesn't help.
 */
export function upgradeGain(club: Club, players: Player[], player: Player): number {
  const atPosition = players.filter((p) => p.clubId === club.id && !p.isYouth && p.position === player.position);
  const starter = atPosition.find((p) => p.starter);
  const bestOther = atPosition.filter((p) => p.id !== player.id).sort((a, b) => b.overall - a.overall)[0];
  const reference = starter ?? bestOther;
  if (!reference) return 1;
  return Math.max(1, player.overall / Math.max(1, reference.overall));
}

/**
 * Deterministic valuation noise (§32). Seeded by clubId + playerId + listingId
 * so "same AI + same auction = same valuation" across reloads/restarts.
 */
export function deterministicValuationNoise(clubId: number, playerId: number, listingId: number): number {
  const [lo, hi] = MARKET_CONFIG.aiBuying.valuationNoiseRange;
  const rng = createRng(clubId * 1000003 + playerId * 10007 + listingId);
  return lo + (hi - lo) * nextDouble(rng);
}

/**
 * AI maximum bid (§30). Base valuation:
 *   calculatedMax = player.value × needMultiplier × upgradeMultiplier × noise
 * then capped by the bidder-specific auction maximum (§10/§102.13.3) AND the
 * AI's financial safety rule (financial-control §13): the AI never submits a
 * bid that would push its financial cushion below 0. This is the ONLY place
 * the AI derives a bid; it never reads competing maximums or hidden data.
 */
export function aiMaximumBid(opts: {
  club: Club;
  player: Player;
  listing: TransferAuction;
  needScore: number;
  upgrade: number;
  buyerDivision: number;
  totalDivisions: number;
  immediateAvailableCash: number;
}): number {
  const need = rangeMap(opts.needScore, MARKET_CONFIG.aiBuying.needMultiplierRange);
  const upgrade = rangeMap(opts.upgrade, MARKET_CONFIG.aiBuying.upgradeMultiplierRange);
  const noise = deterministicValuationNoise(opts.club.id, opts.player.id, opts.listing.id);

  const calculatedMax = opts.player.value * need * upgrade * noise;
  const allowed = maximumAllowedBidByRule(
    opts.player.value,
    opts.buyerDivision,
    opts.listing.sellerDivisionAtListing,
    opts.totalDivisions,
    opts.immediateAvailableCash
  );
  return Math.round(Math.min(calculatedMax, allowed));
}

/**
 * Scale a [lo, hi] multiplier range by how strongly the input (need/upgrade)
 * applies. input 0 → lo; input >= 100 → hi.
 */
function rangeMap(input: number, range: readonly [number, number]): number {
  const [lo, hi] = range;
  const t = Math.max(0, Math.min(1, input / 100));
  return lo + (hi - lo) * t;
}

/**
 * The bidder-specific maximum allowed by rule (value cap × immediate cash).
 * Mirrors maximumAllowedBid in market.ts — reused so the AI ceiling and the
 * shared validator can never diverge.
 */
function maximumAllowedBidByRule(
  playerValue: number,
  buyerDivision: number,
  sellerDivision: number,
  totalDivisions: number,
  immediateAvailableCash: number
): number {
  const capMultiplier = clubTransferCapMultiplier(buyerDivision, sellerDivision, totalDivisions);
  return Math.min(playerValue * capMultiplier, immediateAvailableCash);
}

/**
 * Evaluate one listing for one AI club and submit a single maximum bid (§33).
 *
 * §34 durability: the club evaluates each listing at most once. A durable
 * AiEvaluation row (decision BID or PASS) marks the listing as handled; its
 * absence means a prior submission failed before becoming valid and the AI may
 * retry. PASS is recorded for listings that don't fit (no need / no upgrade /
 * below opening) so a restart can't re-litigate them.
 */
export function evaluateAndBidOnce(
  world: World,
  club: Club,
  listing: TransferAuction,
  opts: {
    buyerDivision: number;
    totalDivisions: number;
    now?: number;
    seasonRolloverAt?: number;
  }
): { ok: true; bid?: number } | { ok: false; error: string; recorded?: boolean } {
  const now = opts.now ?? Date.now();
  const player = world.players.find((p) => p.id === listing.playerId);
  if (!player) return { ok: false, error: "Player not found" };

  const already = world.aiEvaluations.find(
    (e) => e.marketType === "TRANSFER" && e.listingId === listing.id && e.clubId === club.id
  );
  if (already) return { ok: false, error: "Already evaluated" };

  const record = (decision: string, maxBid: number | null) => {
    world.aiEvaluations.push({
      marketType: "TRANSFER",
      listingId: listing.id,
      clubId: club.id,
      evaluatedAt: now,
      decision,
      maxBid,
    });
  };

  const need = positionNeedScore(club, world.players, player.position);
  if (need <= 0) {
    record("PASS", null);
    return { ok: false, error: "No need", recorded: true };
  }

  const upgrade = upgradeGain(club, world.players, player);
  if (upgrade < MARKET_CONFIG.aiBuying.upgradeGainFloor && need < MARKET_CONFIG.aiBuying.needScore.belowRequiredDepth) {
    record("PASS", null);
    return { ok: false, error: "No upgrade", recorded: true };
  }

  // The AI's financial safety rule (financial-control §13): it may only bid up
  // to what keeps its financial cushion >= 0. The affordability ceiling is
  // derived from the shared commitment calculator, never a separate formula.
  const affordable = aiAffordableCommitment(world, club, player.salary);
  const maxBid = aiMaximumBid({
    club,
    player,
    listing,
    needScore: need,
    upgrade,
    buyerDivision: opts.buyerDivision,
    totalDivisions: opts.totalDivisions,
    immediateAvailableCash: affordable,
  });

  if (maxBid < listing.openingPrice) {
    record("PASS", null);
    return { ok: false, error: "Below opening", recorded: true };
  }

  const result = applyMaxBid(world, {
    listing,
    club,
    player,
    proposedMaximum: maxBid,
    buyerDivision: opts.buyerDivision,
    immediateAvailableCash: affordable,
    now,
    seasonRolloverAt: opts.seasonRolloverAt,
  });
  if (!result.ok) {
    // A genuine submission failure (e.g. listing closed in between). Do NOT
    // record — the AI may retry on the next tick while the listing is active.
    return { ok: false, error: result.error, recorded: false };
  }

  record("BID", maxBid);
  return { ok: true, bid: maxBid };
}

export interface AiBidResult {
  clubId: number;
  listingId: number;
  bid: number;
}

/**
 * Run AI buying across a slice of AI clubs. Deterministic rotation across
 * clubs (same stateless bucket pattern as selling, restart-safe). Each
 * selected club evaluates at most maxListingsPerRun active listings in id
 * order and submits at most one maximum per listing (§33/§34).
 */
export function runAiBuying(
  world: World,
  opts: {
    divisionByClub: Map<number, number>;
    totalDivisions: number;
    now?: number;
    seasonRolloverAt?: number;
    maxClubs?: number;
  }
): AiBidResult[] {
  const allBids: AiBidResult[] = [];
  const candidates = world.clubs
    .filter((c) => !humanControlled(c) && c.competitionState === "ACTIVE")
    .sort((a, b) => a.id - b.id);
  const maxClubs = opts.maxClubs ?? MARKET_CONFIG.aiBuying.clubsPerTick;
  if (candidates.length === 0) return allBids;

  const now = opts.now ?? Date.now();
  const bucket = Math.floor(now / (MARKET_CONFIG.aiBuying.evaluationIntervalMinutes * 60_000));
  const start = bucket % candidates.length;

  const clubsToRun = maxClubs > 0 ? Math.min(maxClubs, candidates.length) : candidates.length;
  let clubsTried = 0;
  for (let i = 0; i < candidates.length && clubsTried < clubsToRun; i++) {
    const club = candidates[(start + i) % candidates.length];
    clubsTried += 1;
    const division = opts.divisionByClub.get(club.id);
    if (division === undefined || division <= 0) continue;

    const listings = world.transferAuctions
      .filter((a) => a.status === "ACTIVE" && a.sellerClubId !== club.id && a.deadline > now)
      .sort((a, b) => a.id - b.id)
      .slice(0, MARKET_CONFIG.aiBuying.maxListingsPerRun);

    for (const listing of listings) {
      const result = evaluateAndBidOnce(world, club, listing, {
        buyerDivision: division,
        totalDivisions: opts.totalDivisions,
        now,
        seasonRolloverAt: opts.seasonRolloverAt,
      });
      if (result.ok && result.bid !== undefined) {
        allBids.push({ clubId: club.id, listingId: listing.id, bid: result.bid });
      }
    }
  }
  return allBids;
}
// ---------------------------------------------------------------------------
// AI Free-Agent Participation (§45)
// ---------------------------------------------------------------------------

/**
 * Evaluate one free-agent listing for one AI club (§45) and, when the player
 * genuinely helps the squad and is affordable, submit a single signing-fee
 * maximum. Reuses the same need/upgrade logic as auction buying; the bid is
 * capped by the shared cushion-safe affordability ceiling only (no player-value
 * cap, §43). Idempotent via
 * durable AiEvaluation rows (marketType FREE_AGENT).
 */
export function evaluateFreeAgentAndBid(
  world: World,
  club: Club,
  listing: FreeAgentListing,
  opts: { now?: number }
): { ok: true; bid?: number } | { ok: false; error: string; recorded?: boolean } {
  const now = opts.now ?? Date.now();
  const player = world.players.find((p) => p.id === listing.playerId);
  if (!player) return { ok: false, error: "Player not found" };

  const already = world.aiEvaluations.find(
    (e) => e.marketType === "FREE_AGENT" && e.listingId === listing.id && e.clubId === club.id
  );
  if (already) return { ok: false, error: "Already evaluated" };

  const record = (decision: string, maxBid: number | null) => {
    world.aiEvaluations.push({
      marketType: "FREE_AGENT",
      listingId: listing.id,
      clubId: club.id,
      evaluatedAt: now,
      decision,
      maxBid,
    });
  };

  const need = positionNeedScore(club, world.players, player.position);
  if (need <= 0) {
    record("PASS", null);
    return { ok: false, error: "No need", recorded: true };
  }

  const upgrade = upgradeGain(club, world.players, player);
  if (upgrade < MARKET_CONFIG.aiBuying.upgradeGainFloor && need < MARKET_CONFIG.aiBuying.needScore.belowRequiredDepth) {
    record("PASS", null);
    return { ok: false, error: "No upgrade", recorded: true };
  }

  // Free-agent valuation: value x need x upgrade x noise, NO player-value cap
  // (§43). The AI's affordability ceiling still enforces the §13 cushion rule.
  const affordable = aiAffordableCommitment(world, club, listing.demandedSalary);
  const needMult = rangeMap(need, MARKET_CONFIG.aiBuying.needMultiplierRange);
  const upgradeMult = rangeMap(upgrade, MARKET_CONFIG.aiBuying.upgradeMultiplierRange);
  const noise = deterministicValuationNoise(club.id, player.id, listing.id);
  const calculated = player.value * needMult * upgradeMult * noise;
  const maxBid = Math.round(Math.min(calculated, affordable));

  if (maxBid < listing.openingPrice) {
    record("PASS", null);
    return { ok: false, error: "Below opening", recorded: true };
  }

  const result = applyFreeAgentBid(world, {
    listing,
    club,
    player,
    proposedMaximum: maxBid,
    immediateAvailableCash: affordable,
    now,
  });
  if (!result.ok) {
    return { ok: false, error: result.error, recorded: false };
  }

  record("BID", maxBid);
  return { ok: true, bid: maxBid };
}

/**
 * Run AI free-agent bidding across a slice of AI clubs. Deterministic
 * rotation, bounded listings per run. Each club evaluates at most
 * maxListingsPerRun active FA listings in id order and bids once per listing.
 */
export function runAiFreeAgentBidding(
  world: World,
  opts: { now?: number; maxClubs?: number }
): AiBidResult[] {
  const allBids: AiBidResult[] = [];
  const candidates = world.clubs
    .filter((c) => !humanControlled(c) && c.competitionState === "ACTIVE")
    .sort((a, b) => a.id - b.id);
  const maxClubs = opts.maxClubs ?? MARKET_CONFIG.aiBuying.clubsPerTick;
  if (candidates.length === 0) return allBids;

  const now = opts.now ?? Date.now();
  const bucket = Math.floor(now / (MARKET_CONFIG.aiBuying.evaluationIntervalMinutes * 60_000));
  const start = bucket % candidates.length;

  const clubsToRun = maxClubs > 0 ? Math.min(maxClubs, candidates.length) : candidates.length;
  let clubsTried = 0;
  for (let i = 0; i < candidates.length && clubsTried < clubsToRun; i++) {
    const club = candidates[(start + i) % candidates.length];
    clubsTried += 1;

    const listings = world.freeAgentListings
      .filter((l) => l.status === "ACTIVE" && l.deadline > now)
      .sort((a, b) => a.id - b.id)
      .slice(0, MARKET_CONFIG.aiBuying.maxListingsPerRun);

    for (const listing of listings) {
      const result = evaluateFreeAgentAndBid(world, club, listing, { now });
      if (result.ok && result.bid !== undefined) {
        allBids.push({ clubId: club.id, listingId: listing.id, bid: result.bid });
      }
    }
  }
  return allBids;
}

/** Execute one durable, game-clock-owned AI market tick. */
export function runAiMarketTick(world: World, now = Date.now()): boolean {
  const divisionByClub = new Map<number, number>();
  for (const club of world.clubs) {
    if (club.isHuman || club.ownerUserId !== null || club.competitionState !== "ACTIVE") continue;
    divisionByClub.set(club.id, divisionForClub(world, club.id));
  }
  const totalDivisions = Math.max(1, lowestActiveTier(world, world.mp.seasonId));
  const remainingDays = Math.max(1, gameConfig.seasonDays - (world.mp.seasonDayIndex ?? world.dayIndex));
  const seasonRolloverAt = now + remainingDays * 24 * 60 * 60 * 1000;
  const created = runAiSelling(world, {
    divisionByClub,
    totalDivisions,
    now,
    seasonRolloverAt,
    maxClubs: MARKET_CONFIG.aiSelling.clubsPerTick,
  });
  const bids = runAiBuying(world, {
    divisionByClub,
    totalDivisions,
    now,
    seasonRolloverAt,
    maxClubs: MARKET_CONFIG.aiBuying.clubsPerTick,
  });
  const freeAgentBids = runAiFreeAgentBidding(world, {
    now,
    maxClubs: MARKET_CONFIG.aiBuying.clubsPerTick,
  });
  return created.length > 0 || bids.length > 0 || freeAgentBids.length > 0;
}
