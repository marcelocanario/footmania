import type { World } from "../game/types";
import { EVENT_CODES, GOAL_SUBTYPES } from "../game/constants";
import { multiplayerDayLabel, weekdayName } from "../game/calendar";
import { getPosition } from "../game/league";
import { eloRatings } from "../game/elo";
import { FORMATION_NAMES, MOTD_NEWS_KIND, POSITION_NAMES, STYLE_NAMES, PRESSING_NAMES, DIRECTION_NAMES, TACTICAL_POSITION_NAMES } from "../game/constants";
import { gameConfig } from "../config";
import { getCommitmentTotals, financialState, remainingSeasonFraction } from "../game/finance";
import { resolveClubKits } from "../game/kits";
import { newsVisibleTo } from "../game/news";
import { calendarValues, leagueTurnKey, phaseForSeasonDayIndex } from "./seasonCalendar";
import { seasonKey } from "../game/clock";
import { conditionLabel, injuryDaysRemaining } from "../game/energyInjury";
import {
  canonicalFromClub,
  decayedStoredFamiliarity,
  effectiveFamiliarity,
  projectSetups,
} from "../game/familiarity";

const snapshotCache = new WeakMap<World, Map<number, unknown>>();

/** Wire shape of one news item as served to clients. */
export function newsItemView(n: World["news"][number], dayLabelText: string) {
  return {
    id: n.id,
    dayIndex: n.dayIndex,
    dayLabel: dayLabelText,
    text: n.text,
    kind: n.kind,
    ...(n.headline !== undefined ? { headline: n.headline } : {}),
    ...(n.subject !== undefined ? { subject: n.subject } : {}),
    ...(n.entries && n.entries.length > 0 ? { entries: n.entries } : {}),
    ...(n.recipientClubId !== undefined ? { recipientClubId: n.recipientClubId } : {}),
  };
}

/** Goal/assist counts a player has scored in in-progress live matches. The
 *  Player rows are only committed at full-time, so cards add these deltas to
 *  reflect a goal the moment it happens. */
export interface LivePlayerStatDelta {
  goals: number;
  assists: number;
}

/** Sum goals/assists from the live states' GOAL events, keyed by player id. */
export function liveMatchStatDeltas(world: World): Map<number, LivePlayerStatDelta> {
  const out = new Map<number, LivePlayerStatDelta>();
  for (const st of world.liveMatches) {
    for (const e of st.events) {
      if (e.type !== EVENT_CODES.GOAL || e.goalType === GOAL_SUBTYPES.PENALTY) continue;
      if (e.playerId !== null) {
        const cur = out.get(e.playerId) ?? { goals: 0, assists: 0 };
        cur.goals++;
        out.set(e.playerId, cur);
      }
      if (e.player2Id !== null) {
        const cur = out.get(e.player2Id) ?? { goals: 0, assists: 0 };
        cur.assists++;
        out.set(e.player2Id, cur);
      }
    }
  }
  return out;
}

export function playerView(
  p: World["players"][number],
  loan?: { onLoan: boolean; onLoanOut: boolean; loanClubName: string | null; loanFromName: string | null },
  absoluteGameDay = 0,
  liveDelta?: LivePlayerStatDelta | null,
  /** Turn key of the viewing club's next unplayed division fixture. Enables
   *  the per-turn yellow-card warning; callers whose context is not "this
   *  player represents the viewing club" (loans, other-club views) omit it. */
  nextFixtureTurnKey?: number | null
) {
  const nick = (p.nickname ?? "").trim();
  const goals = p.seasonGoals + (liveDelta?.goals ?? 0);
  const assists = p.seasonAssists + (liveDelta?.assists ?? 0);
  const careerGoals = p.careerGoals + (liveDelta?.goals ?? 0);
  const careerAssists = p.careerAssists + (liveDelta?.assists ?? 0);
  // One booking away from the per-turn limit, next match still inside the same
  // turn: another yellow in that match triggers the automatic ban.
  const { turnYellowLimit } = gameConfig.discipline;
  const yellowWarning =
    p.suspendedGames === 0 &&
    nextFixtureTurnKey !== undefined &&
    nextFixtureTurnKey !== null &&
    (p.yellowsTurnKey ?? null) === nextFixtureTurnKey &&
    turnYellowLimit >= 1 &&
    (p.turnYellows ?? 0) >= turnYellowLimit - 1;
  return {
    id: p.id,
    name: p.name,
    nickname: p.nickname ?? null,
    displayName: nick.length > 0 ? nick : p.name,
    age: p.age,
    country: p.country,
    position: p.position,
    positionName: POSITION_NAMES[p.position],
    tacPos: p.tacPos,
    tacPosName: TACTICAL_POSITION_NAMES[p.tacPos] ?? "",
    squadNumber: p.squadNumber ?? null,
    overall: p.overall,
    skills: p.skills,
    energy: p.energy,
    value: p.value,
    salary: p.salary,
    contractDays: p.contractDays,
    injuryDays: injuryDaysRemaining(p, absoluteGameDay),
    injuryDaysRemaining: injuryDaysRemaining(p, absoluteGameDay),
    injuryCause: p.injuryCause ?? null,
    injuryUntilAbsoluteGameDay: p.injuryUntilAbsoluteGameDay ?? null,
    conditionLabel: conditionLabel(p, absoluteGameDay),
    isYouth: p.isYouth,
    seasonGoals: goals,
    seasonAssists: assists,
    careerGoals,
    careerAssists,
    yellows: p.yellows,
    reds: p.reds,
    turnYellows: p.turnYellows ?? 0,
    yellowWarning,
    onSale: p.onSale,
    suspended: p.suspendedGames > 0,
    suspendedGames: p.suspendedGames,
    loanId: p.loanId,
    releaseClause: p.releaseClause,
    onLoan: loan?.onLoan ?? false,
    onLoanOut: loan?.onLoanOut ?? false,
    loanClubName: loan?.loanClubName ?? null,
    loanFromName: loan?.loanFromName ?? null,
  };
}

/** One parsed Best XI member of a best_xi season award. */
export interface SeasonAwardEntryView {
  id: number;
  clubId: number | null;
  name: string;
  /** False once the player has left the world (retired/deleted): the client
   *  renders the name as plain text instead of a player-card link. */
  active: boolean;
}

/**
 * Parse the structured Best XI detail written by computeSeasonAwards
 * (`[{id, clubId, name}]`) and flag which members still exist in the world.
 * Legacy rows stored bare name arrays; those parse to names-only entries with
 * id = null so clients render them as non-clickable text.
 */
export function bestXiEntries(detail: string | null, world: World): (SeasonAwardEntryView | { id: null; clubId: null; name: string; active: false })[] | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((entry) => {
      if (typeof entry === "string") return { id: null, clubId: null, name: entry, active: false };
      const e = entry as { id?: unknown; clubId?: unknown; name?: unknown };
      if (typeof e.id !== "number" || typeof e.name !== "string") return null;
      const id = e.id as number;
      return {
        id,
        clubId: typeof e.clubId === "number" ? (e.clubId as number) : null,
        name: e.name as string,
        active: world.players.some((p) => p.id === id),
      } satisfies SeasonAwardEntryView;
    }).filter((entry): entry is SeasonAwardEntryView | { id: null; clubId: null; name: string; active: false } => entry !== null);
  } catch {
    return null;
  }
}

/** Season awards as served to clients, with Best XI entries resolved. */
export function seasonAwardsView(world: World) {
  return world.seasonAwards.slice().reverse().map((award) => {
    if (award.category !== "best_xi") return award;
    const entries = bestXiEntries(award.detail, world);
    return entries ? { ...award, entries } : award;
  });
}
/** Loan context for a player relative to a club, or neutral defaults. */
function loanInfo(
  world: World,
  p: World["players"][number],
  clubId: number,
  loanById?: ReadonlyMap<number, World["loans"][number]>,
  clubById?: ReadonlyMap<number, World["clubs"][number]>,
) {
  if (p.loanId === null) {
    return { onLoan: false, onLoanOut: false, loanClubName: null as string | null, loanFromName: null as string | null };
  }
  const loan = loanById?.get(p.loanId) ?? world.loans.find((l) => l.id === p.loanId);
  if (!loan || loan.recalled || loan.toClubId === null) {
    return { onLoan: false, onLoanOut: false, loanClubName: null as string | null, loanFromName: null as string | null };
  }
  return {
    onLoan: p.clubId === clubId && loan.fromClubId !== clubId,
    onLoanOut: loan.fromClubId === clubId && p.clubId !== clubId,
    loanClubName: clubById?.get(loan.toClubId)?.name ?? world.clubs.find((c) => c.id === loan.toClubId)?.name ?? null,
    loanFromName: clubById?.get(loan.fromClubId)?.name ?? world.clubs.find((c) => c.id === loan.fromClubId)?.name ?? null,
  };
}
export function buildSnapshot(world: World, clubId: number, includeMarket = true, compact = false) {
  const clubById = new Map(world.clubs.map((item) => [item.id, item]));
  const playerById = new Map(world.players.map((item) => [item.id, item]));
  const loanById = new Map(world.loans.map((item) => [item.id, item]));
  const club = clubById.get(clubId);
  const dayLabel = (day: number) => multiplayerDayLabel(day);
  const currentDateLabel = multiplayerDayLabel(world.dayIndex);
  const currentDayOfWeek = new Date(Date.UTC(world.mp.seasonYear, world.mp.seasonMonth - 1, Math.max(1, world.dayIndex))).getUTCDay();
  const calendar = calendarValues();
  const seasonDayIndex = world.mp.seasonDayIndex ?? world.dayIndex;
  const currentSeasonDivisions = new Set(
    world.competitions
      .filter((c) => c.kind === "division" && c.seasonId === world.mp.seasonId)
      .map((c) => c.id),
  );
  const nextFixture = world.fixtures
    .filter((f) => !f.played && currentSeasonDivisions.has(f.competitionId) && f.dayIndex >= world.dayIndex && (f.homeClubId === clubId || f.awayClubId === clubId))
    .sort((a, b) => a.dayIndex - b.dayIndex)[0];

  const ratings = eloRatings(world);
  const competitions = world.competitions
    .filter((c) => c.kind !== "division" || c.seasonId === world.mp.seasonId)
    .filter((c) => !compact || c.standings[clubId] !== undefined || c.groupStandings.some((group) => group.rows[clubId] !== undefined))
    .map((c) => {
    const position = c.kind === "league" || c.kind === "division" ? getPosition(c, clubId, ratings) : 0;
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      stage: c.stage,
      round: c.round,
      // Pyramid coordinates (divisions only) so the UI can show "Division X · Group Y".
      tier: c.tier ?? null,
      groupIndex: c.groupIndex ?? null,
      position,
      winnerId: c.winners[0] ?? null,
    };
    });

  const liveStatDeltas = liveMatchStatDeltas(world);
  // Turn key of the club's next unplayed division fixture: players booked in
  // that same turn are one card away from the automatic ban (squad warning).
  const nextFixtureTurnKey = nextFixture ? leagueTurnKey(world.mp.seasonNumber ?? 0, nextFixture.round) : null;
  const squad = world.players
    .filter((p) => p.clubId === clubId && !p.isYouth)
    .sort((a, b) => b.overall - a.overall)
    .map((p) => playerView(p, loanInfo(world, p, clubId, loanById, clubById), world.mp.absoluteGameDay ?? world.dayIndex, liveStatDeltas.get(p.id) ?? null, nextFixtureTurnKey));
  const juniors = world.players
    .filter((p) => p.clubId === clubId && p.isYouth)
    .sort((a, b) => b.overall - a.overall)
    .map((p) => playerView(p, loanInfo(world, p, clubId, loanById, clubById), world.mp.absoluteGameDay ?? world.dayIndex, liveStatDeltas.get(p.id) ?? null, nextFixtureTurnKey));
  // Players the club owns but that are away on loan, so the ceding club can
  // still see them in its roster.
  const loanedOutIds = new Set(
    world.loans
      .filter((loan) => loan.fromClubId === clubId && loan.toClubId !== null && !loan.recalled)
      .map((loan) => loan.id),
  );
  const loanedOut = world.players
    .filter((p) => p.clubId !== clubId && p.loanId !== null && loanedOutIds.has(p.loanId))
    .sort((a, b) => b.overall - a.overall)
    .map((p) => playerView(p, loanInfo(world, p, clubId, loanById, clubById), world.mp.absoluteGameDay ?? world.dayIndex, liveStatDeltas.get(p.id) ?? null));
  // Loaned-out players appear in the senior roster (greyed out in the UI).
  const squadAll = [...squad, ...loanedOut].sort((a, b) => b.overall - a.overall);

  // Admin announcements ("motd") are pinned ahead of the chronological feed
  // from the FULL history — older announcements remain visible no matter how
  // much match news follows them. Admins may retain multiple announcements.
  // Club-private items (recipientClubId) only reach that club's manager.
  const pinnedNews = world.news.filter((n) => n.kind === MOTD_NEWS_KIND);
  const chronological = world.news
    .filter((n) => n.kind !== MOTD_NEWS_KIND && newsVisibleTo(n, clubId))
    .slice(-(compact ? 12 : 30))
    .reverse();
  const news = [...pinnedNews, ...chronological].map((n) => newsItemView(n, dayLabel(n.dayIndex)));

  const auctions = includeMarket ? (() => {
    const bidsByListing = new Map<number, typeof world.marketBids>();
    for (const bid of world.marketBids) {
      const bids = bidsByListing.get(bid.listingId) ?? [];
      bids.push(bid);
      bidsByListing.set(bid.listingId, bids);
    }
    return world.transferAuctions
      .filter((a) => a.status === "ACTIVE")
      .map((a) => {
      const p = playerById.get(a.playerId);
      const listingBids = bidsByListing.get(a.id) ?? [];
      const myBid = clubId !== null ? listingBids.find((b) => b.clubId === clubId) : undefined;
      return {
        id: a.id,
        playerId: a.playerId,
        playerName: p?.name ?? "",
        overall: p?.overall ?? 0,
        position: p?.position ?? 0,
        age: p?.age ?? 0,
        salary: p?.salary ?? 0,
        skills: p?.skills ?? { gol: 0, vel: 0, tec: 0, pas: 0, des: 0, arm: 0, fin: 0 },
        value: p?.value ?? 0,
        openingPrice: a.openingPrice,
        currentPrice: a.currentPrice,
        bidIncrement: a.bidIncrement,
        bidderCount: listingBids.length,
        sellerClubId: a.sellerClubId,
        sellerName: clubById.get(a.sellerClubId)?.name ?? "",
        deadline: a.deadline,
        status: a.status,
        myMaxBid: myBid?.maxBid ?? null,
        amILeading: a.leadingClubId === clubId,
      };
      });
  })() : [];

  // Free agents with an active market listing (Phase 7). Raw clubId === null
  // players without a listing are not market-visible yet.
  const freeAgents = includeMarket
    ? (() => {
      const listedPlayerIds = new Set(world.freeAgentListings.filter((listing) => listing.status === "ACTIVE").map((listing) => listing.playerId));
      return world.players
        .filter((p) => p.clubId === null && listedPlayerIds.has(p.id))
        .sort((a, b) => b.overall - a.overall)
        .slice(0, 30)
        .map((p) => playerView(p, undefined, world.mp.absoluteGameDay ?? world.dayIndex, liveStatDeltas.get(p.id) ?? null));
    })()
    : [];

  return {
    save: {
      year: world.year,
      dayIndex: world.dayIndex,
       dateLabel: currentDateLabel,
       dayOfWeek: weekdayName(currentDayOfWeek),
       seasonDays: calendar.seasonDays,
       seasonDayIndex,
       phase: world.mp.phase ?? phaseForSeasonDayIndex(seasonDayIndex),
       interseasonAfterMatchDays: calendar.interseasonAfterMatchDays,
       interseasonBeforeNextSeasonDays: calendar.interseasonBeforeNextSeasonDays,
       lastLeagueMatchDayIndex: calendar.lastLeagueMatchDayIndex,
       interseasonStartIndex: calendar.interseasonStartIndex,
       preparationStartIndex: calendar.preparationStartIndex,
    },
    seasonSummary: world.seasonSummary
      ? {
          leagueChampion: world.seasonSummary.leagueChampionId !== null ? clubById.get(world.seasonSummary.leagueChampionId)?.name ?? null : null,
          leagueRunnerUp: world.seasonSummary.leagueRunnerUpId !== null ? clubById.get(world.seasonSummary.leagueRunnerUpId)?.name ?? null : null,
          // IDs so clients can link to the team screen.
          leagueChampionId: world.seasonSummary.leagueChampionId,
          leagueRunnerUpId: world.seasonSummary.leagueRunnerUpId,
        }
      : null,
    club: club
      ? {
          id: club.id,
          name: club.name,
          shortName: club.shortName,
          country: club.country,
          highestDivision: club.highestDivision,
          cash: club.cash,
          stadiumName: club.stadiumName,
          primaryColor: club.primaryColor,
          secondaryColor: club.secondaryColor,
          kits: resolveClubKits(club),
          logoVariant: club.logoVariant ?? 0,
          hasCustomLogo: Boolean(club.customLogo && club.customLogo.status === "ACTIVE"),
          coachName: club.coachName,
          coachEditAllowed:
            !club.coachNameChangedSeasonKey ||
            club.coachNameChangedSeasonKey !== seasonKey({ year: world.mp.seasonYear, month: world.mp.seasonMonth }),
          trainingFocus: club.trainingFocus,
          competitionState: club.competitionState,
          // Financial snapshot (financial-control §55): the derived cushion and
          // warning state, computed authoritatively on the server.
          finance: (() => {
            const totals = getCommitmentTotals(world, club);
            return {
              activeBidCommitments: totals.activeBidCommitments,
              remainingSalaryCommitments: totals.remainingSalaryCommitments,
              contingentSalary: totals.contingentSalary,
              immediateAvailableCash: totals.immediateAvailableCash,
              remainingSeasonFraction: club.competitionState === "PROVISIONAL" ? 1 : remainingSeasonFraction(world),
              financialCushion: totals.financialCushion,
              status: financialState(world, club),
            };
          })(),
          tactics: club.tactics
            ? (() => {
                // §17: expose the current setup's drilled (lazily decayed)
                // familiarity plus server-computed projections for every
                // style/pressing/direction combination at the saved formation,
                // so clients render bars without duplicating the math.
                const gameDay = world.mp.absoluteGameDay ?? world.dayIndex;
                const srcValue = effectiveFamiliarity(club, gameDay);
                const srcSetup = canonicalFromClub(club.tactics);
                const map = club.tacticFamiliarity ?? null;
                return {
                  formation: club.tactics.formation,
                  style: club.tactics.style,
                  pressing: club.tactics.pressing,
                  direction: club.tactics.direction,
                  formationName: FORMATION_NAMES[club.tactics.formation] ?? "",
                  styleName: STYLE_NAMES[club.tactics.style] ?? "",
                  pressingName: PRESSING_NAMES[club.tactics.pressing] ?? "",
                  directionName: DIRECTION_NAMES[club.tactics.direction] ?? "",
                  familiarity: Math.round(srcValue),
                  projections: projectSetups(
                    srcValue,
                    srcSetup,
                    club.tactics.formation,
                    STYLE_NAMES.length,
                    PRESSING_NAMES.length,
                    DIRECTION_NAMES.length,
                    (style, pressing, direction) =>
                      decayedStoredFamiliarity(map, `${club.tactics.formation}-${style}-${pressing}-${direction}`, gameDay)
                  ),
                };
              })()
            : null,
          trophies: club.trophies,
          ledger: {
            income: club.ledger.income.slice(-20).reverse(),
            expense: club.ledger.expense.slice(-20).reverse(),
          },
        }
      : null,
    nextFixture: nextFixture
      ? {
          id: nextFixture.id,
          home: world.clubs.find((c) => c.id === nextFixture.homeClubId)?.name ?? "",
          away: world.clubs.find((c) => c.id === nextFixture.awayClubId)?.name ?? "",
          // IDs so clients can link both teams to the team screen.
          homeClubId: nextFixture.homeClubId,
          awayClubId: nextFixture.awayClubId,
          dayLabel: dayLabel(nextFixture.dayIndex),
          dayIndex: nextFixture.dayIndex,
          isHome: nextFixture.homeClubId === clubId,
          // Raw epoch ms; the client renders it browser-local via utils/time.ts
          // so the dashboard date matches every other localized timestamp
          // instead of a server-side UTC label (plan 9).
          kickoffAt: nextFixture.kickoffAt ?? null,
        }
      : null,
    competitions,
    squad: squadAll,
    juniors,
    loanedOut,
    news,
    auctions,
    freeAgents,
    records: world.records,
    seasonAwards: seasonAwardsView(world).slice(0, compact ? 12 : 40),
  };
}

/** Reuse the expensive derived snapshot while the persisted world revision is unchanged. */
export function buildCachedSnapshot(world: World, clubId: number, _revision: number) {
  let byClub = snapshotCache.get(world);
  if (!byClub) {
    byClub = new Map<number, unknown>();
    snapshotCache.set(world, byClub);
  }
  const cached = byClub.get(clubId);
  if (cached) return cached;
  const snapshot = buildSnapshot(world, clubId, false, true);
  byClub.set(clubId, snapshot);
  return snapshot;
}
