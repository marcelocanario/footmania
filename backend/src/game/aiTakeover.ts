import type { Club, World } from "./types";
import { closeMarketInvolvementForFreeze } from "./market";
import { endLoan } from "./season";
import { generateFillerRoster, totalDivisionsForGeneration } from "./clubGenerator";
import { recordActiveClubBoundaryChange } from "./population";
import { advanceLiveMatches } from "./world";
import { ELO_CONFIG } from "../config";
import { createRng, nextInt } from "./rng";
import { FEATURED_COUNTRIES } from "./countries";
import { deriveAiKits } from "./kits";
import { generateName } from "./names";
import { NEWS_SUBJECTS, publishNews } from "./news";
import { msg } from "../i18n/catalog";

/**
 * Admin account deletion: a deleted player's ACTIVE club is replaced in place
 * by a brand-new AI team (the user's choice: the human team is deleted, a
 * fresh AI filler takes the slot, inheriting only the points and results
 * already in the standings/fixture history — nothing else).
 *
 * The club row KEEPS its id so completed fixtures, results and standings stay
 * immutable (invariant #16); every playable property is reset to fresh-filler
 * semantics: new deterministic AI identity, static generated squad, no
 * finances, no market involvement, no loans, no history containers. The
 * engine already treats `ownerUserId === null && isHuman === false` clubs as
 * ephemeral AI everywhere (lineups, payroll, market, rollover removal), so the
 * converted club simply becomes a filler from this moment on.
 */

/** Regenerate the identity of a club as a deterministic filler AI team. */
export function regenerateAiIdentity(world: World, club: Club): void {
  // Deterministic noise: seeded from the stable club id so a retry or a
  // different process can never reroll a different identity (design rule:
  // deterministic noise is seeded from stable IDs).
  const rng = createRng(Math.imul(club.id + 1, 0x9e3779b1) >>> 0);
  const cities = [
    "London", "Madrid", "Rome", "Munich", "Paris", "Lisbon", "Amsterdam", "Brussels",
    "Vienna", "Zurich", "Stockholm", "Dublin", "Warsaw", "Prague", "Budapest", "Athens",
    "Istanbul", "Kyiv", "Buenos Aires", "Montevideo", "Santiago", "Lima", "Bogota", "Mexico City",
    "New York", "Los Angeles", "Chicago", "Toronto", "Tokyo", "Seoul", "Shanghai", "Mumbai",
  ];
  const city = cities[nextInt(rng, cities.length)];
  const kits = deriveAiKits(club.id);
  club.name = `${city} FC`;
  club.shortName = club.name;
  club.country = FEATURED_COUNTRIES[nextInt(rng, FEATURED_COUNTRIES.length)].code;
  club.stadiumName = `${city} Stadium`;
  club.coachName = generateName(rng, club.country);
  club.coachNameChangedSeasonKey = null;
  club.kits = kits;
  club.primaryColor = kits.home.primary;
  club.secondaryColor = kits.home.secondary;
  club.logoVariant = 0;
  club.customLogo = null;
}

/**
 * Replace an ACTIVE human club with a brand-new AI filler in place.
 * Returns a summary for the audit trail.
 */
export function replaceActiveClubWithAi(world: World, club: Club, now: number): { converted: boolean; removedPlayers: number; addedPlayers: number; listings: number; bids: number } {
  // 0. If the club is in a live match, force-finish it FIRST: destroying the
  //    squad below would otherwise leave a LiveMatchState pointing at player
  //    ids that no longer exist (split-brain at finalize). This is the same
  //    authoritative "resolve now" path the admin scheduler uses, so results,
  //    standings and player effects are applied exactly as if the match had
  //    been resolved manually.
  if (world.liveMatches.some((m) => m.homeClubId === club.id || m.awayClubId === club.id)) {
    advanceLiveMatches(world, now, { forceFinish: true });
  }

  // The current tier of the club (its division this season). The converted AI
  // team keeps this; it does not inherit the human-era highest-division
  // milestone.
  const currentTier =
    world.competitions.find((c) => c.kind === "division" && c.status !== "ARCHIVED" && c.seasonId === world.mp.seasonId && c.standings[club.id] !== undefined)?.tier ??
    club.highestDivision;

  // 1. Close every live market involvement BEFORE the roster is swapped, so
  //    no listing/bid can reference players that are about to disappear.
  const market = closeMarketInvolvementForFreeze(world, club.id, now);

  // 2. End every loan boundary involving the club (players return to their
  //    lenders; loaned-in players go back).
  for (const loan of world.loans.filter((l) => !l.recalled && (l.fromClubId === club.id || l.toClubId === club.id))) {
    endLoan(world, loan);
  }

  // 3. Destroy the human squad (seniors + youth) and generate a fresh static
  //    filler roster. The population boundary correction nets the roster
  //    change: the club itself stays inside the active boundary, so its
  //    target contribution is unchanged and only the stock delta matters
  //    (leave with the old stock, arrive with the new one).
  const oldSquad = world.players.filter((p) => p.clubId === club.id);
  const removed = oldSquad.length;
  world.players = world.players.filter((p) => p.clubId !== club.id);
  // The human club's creation idempotency key must not block the fresh filler
  // roster: generateFillerRoster guards on the same `club-creation:{id}` key
  // that createHumanClub consumed, so clear it before regenerating.
  const creationKey = `club-creation:${club.id}`;
  world.generationEvents = world.generationEvents.filter((key) => key !== creationKey);
  // Detach any player still carrying a stale loan reference (defensive).
  for (const player of world.players) {
    if (player.loanId !== null) {
      const loanStillExists = world.loans.some((l) => l.id === player.loanId);
      if (!loanStillExists) {
        player.loanId = null;
        player.clubId = null;
        player.starter = false;
      }
    }
  }

  // 4. New identity + fresh filler roster.
  regenerateAiIdentity(world, club);
  const added = generateFillerRoster({
    world,
    club,
    currentDivision: club.highestDivision,
    highestDivisionReached: club.highestDivision,
    totalDivisions: totalDivisionsForGeneration(world),
    seasonId: world.mp.seasonId || null,
  }).length;

  // 5. Reset every playable/history container: the new AI team inherits only
  //    the points and results already recorded in standings/fixtures.
  club.ownerUserId = null;
  club.isHuman = false;
  club.cash = 0;
  club.ledger = { income: [], expense: [] };
  club.trophies = {};
  // Automation presets are club-scoped configuration stored outside the World
  // object (plan §11 Part 4) — the caller (routes/admin.ts, which holds the
  // prisma handle this pure domain function doesn't) clears them separately.
  club.tacticFamiliarity = null;
  club.savedLineup = null;
  club.captainId = null;
  club.penaltyTakerId = null;
  club.trainingFocus = "assistant";
  club.eloRating = ELO_CONFIG.initial;
  club.eloRatedMatches = 0;
  club.lastMeaningfulActivityAt = null;
  club.abandonmentEligibleAt = null;
  // The "highest division ever reached" milestone from the human era is not
  // inherited: keep only the tier the club currently occupies. liveMatchAt is
  // NOT touched here — any live match involving the club was force-finished in
  // step 0, and finalizeLiveMatch already cleared the anchor.
  club.highestDivision = currentTier;
  club.competitionState = "ACTIVE";
  // The single-season filler roster records its creation so a retry cannot
  // generate a second squad (same idempotency key rule as createFillerAI).
  if (!world.generationEvents.includes(`club-creation:${club.id}`)) {
    world.generationEvents.push(`club-creation:${club.id}`);
  }

  const netDelta = added - removed;
  if (netDelta !== 0) {
    // Leave the boundary with the old stock, re-enter with the new one: the
    // gap delta is exactly old - new, matching the roster swap.
    recordActiveClubBoundaryChange(world, removed, -1);
    recordActiveClubBoundaryChange(world, added, 1);
  }

  publishNews(world, {
    kind: "mp",
    subject: NEWS_SUBJECTS.clubStatus,
    clubId: club.id,
    headline: "news.headline.pyramid",
    entries: [{ key: `ai-takeover:${club.id}:${now}`, label: club.name, detail: msg("news.detail.aiTakeover") }],
  });

  return { converted: true, removedPlayers: removed, addedPlayers: added, listings: market.listings, bids: market.bids };
}

/**
 * Remove a NON-active human club (NEW / PROVISIONAL / DORMANT) entirely:
 * nothing competitive references it, so the club, its squad and its pending
 * queue/allocation entries are simply destroyed.
 */
export function removeNonActiveClub(world: World, club: Club, now: number): { converted: boolean; removedPlayers: number; addedPlayers: number; listings: number; bids: number } {
  const market = closeMarketInvolvementForFreeze(world, club.id, now);
  for (const loan of world.loans.filter((l) => !l.recalled && (l.fromClubId === club.id || l.toClubId === club.id))) {
    endLoan(world, loan);
  }
  const removed = world.players.filter((p) => p.clubId === club.id).length;
  world.players = world.players.filter((p) => p.clubId !== club.id);
  world.loans = world.loans.filter((l) => l.fromClubId !== club.id && l.toClubId !== club.id);
  world.clubs = world.clubs.filter((c) => c.id !== club.id);
  // Pending queue/allocation rows reference the removed club id.
  world.mpQueue = world.mpQueue.filter((q) => q.clubId !== club.id);
  world.seasonAllocations = world.seasonAllocations.filter((a) => a.clubId !== club.id);
  world.mpMemberships = world.mpMemberships.filter((m) => m.clubId !== club.id);
  world.mpClubSeasons = world.mpClubSeasons.filter((cs) => cs.clubId !== club.id);
  return { converted: false, removedPlayers: removed, addedPlayers: 0, listings: market.listings, bids: market.bids };
}
