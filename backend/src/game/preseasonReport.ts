import type { Club, NewsEntry, World } from "./types";
import { gameConfig } from "../config";
import { NEWS_SUBJECTS, publishNews } from "./news";
import { msg } from "../i18n/catalog";
import { activeDivisionForClub, tierOf } from "./multiplayer";
import { getCommitmentTotals, financialState } from "./finance";
import { multiplayerDayLabel } from "./calendar";

/**
 * Pre-season report (news overhaul): one immersive message per human-managed
 * club on the first day of the new season, written at SEASON_ROLLOVER_COMMIT
 * once divisions, budgets, fixtures and academy intake are final. Idempotent
 * per club/season so a retried commit cannot duplicate reports.
 *
 * The report is the one grouped message with bespoke prose: its `body` is a
 * direct `news.preseason` ref whose params (division, cash, contract count,
 * finance state) the client composes into the lead + finance + contract leads,
 * followed by the entry fact list. `text` stays empty.
 */

const FINANCE_STATE: Record<string, "safe" | "atRisk" | "negative"> = {
  SAFE: "safe",
  AT_RISK: "atRisk",
  NEGATIVE_CASH: "negative",
};

function financeKey(state: string): "safe" | "atRisk" | "negative" {
  return FINANCE_STATE[state] ?? "safe";
}

function previousSeasonFinish(world: World, clubId: number): { divisionName: string; position: number } | null {
  const history = world.seasonHistory[world.seasonHistory.length - 1];
  if (!history) return null;
  for (const div of history.divisions) {
    const index = div.standings.findIndex((row) => row.clubId === clubId);
    if (index >= 0) return { divisionName: div.divisionName, position: index + 1 };
  }
  return null;
}

function divisionTier(name: string): number | null {
  const tier = Number(name.split(".")[0]);
  return Number.isInteger(tier) && tier > 0 ? tier : null;
}

function nextFixtureLine(world: World, clubId: number): { opponent: string; venue: "home" | "away"; day: string } | null {
  let best: { dayIndex: number; homeClubId: number; awayClubId: number } | undefined;
  for (const fixture of world.fixtures) {
    if (fixture.played || (fixture.homeClubId !== clubId && fixture.awayClubId !== clubId)) continue;
    if (!best || fixture.dayIndex < best.dayIndex) best = fixture;
  }
  if (!best) return null;
  const opponentId = best.homeClubId === clubId ? best.awayClubId : best.homeClubId;
  const opponent = world.clubs.find((candidate) => candidate.id === opponentId);
  return { opponent: opponent?.name ?? "TBD", venue: best.homeClubId === clubId ? "home" : "away", day: multiplayerDayLabel(best.dayIndex) };
}

/** Write the pre-season report for every eligible human club. */
export function generatePreseasonReports(world: World): void {
  const seasonId = world.mp.seasonId;
  const warningDays = gameConfig.seasonDays * gameConfig.contractWarningSeasons;
  for (const club of world.clubs) {
    if (club.ownerUserId === null || club.competitionState === "DORMANT") continue;
    generatePreseasonReport(world, club, seasonId, warningDays);
  }
}

export function generatePreseasonReport(world: World, club: Club, seasonId: number, warningDays: number): void {
  // Idempotency guard: a retried SEASON_ROLLOVER_COMMIT must not duplicate the report.
  if (
    world.news.some((item) => item.kind === "season" && item.subject === NEWS_SUBJECTS.preseasonReport && item.recipientClubId === club.id && item.seasonId === seasonId)
  ) return;

  const entries: NewsEntry[] = [];
  const squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
  const juniors = world.players.filter((p) => p.clubId === club.id && p.isYouth);

  // --- League section ---
  const division = activeDivisionForClub(world, club.id);
  const tier = division ? tierOf(division) : null;
  const previous = previousSeasonFinish(world, club.id);
  if (division && tier !== null) {
    entries.push({ key: "league", label: msg("news.preseason.division", { division: tier }), detail: `${division.name} · Group ${(division.groupIndex ?? 0) + 1}` });
    if (previous && previous.divisionName === division.name) {
      entries.push({ key: "last-finish", label: msg("news.preseason.lastSeason"), detail: msg("news.preseason.finished", { count: previous.position, division: previous.divisionName }) });
    } else if (previous && tier !== null) {
      const previousTier = divisionTier(previous.divisionName);
      const movement = previousTier === null || previousTier === tier ? "regrouped" : previousTier > tier ? "promoted" : "relegated";
      entries.push({ key: "last-finish", label: msg("news.preseason.lastSeason"), detail: msg("news.preseason.finished", { count: previous.position, division: previous.divisionName }) });
      entries.push({ key: "movement", label: msg("news.preseason.movement"), detail: msg(`news.preseason.movement_${movement}`) });
    }
  }

  // --- Finance section ---
  const totals = getCommitmentTotals(world, club);
  const finance = financeKey(financialState(world, club));
  entries.push({ key: "cash", label: msg("news.preseason.cash"), detail: msg("news.preseason.amount", { amount: club.cash }) });
  entries.push({
    key: "cushion",
    label: msg("news.preseason.cushion"),
    detail: msg(`news.preseason.cushion_${finance}`, { amount: totals.financialCushion }),
  });

  // --- Contract section ---
  const expiring = squad
    .filter((p) => p.loanId === null && p.contractDays <= warningDays)
    .sort((a, b) => a.contractDays - b.contractDays);
  for (const player of expiring.slice(0, 12)) {
    entries.push({ key: `contract:${player.id}`, label: player.name, detail: msg("news.detail.contractWarning", { count: player.contractDays }) });
  }
  if (expiring.length > 12) {
    entries.push({ key: "contract-more", label: msg("news.preseason.contractsMore", { count: expiring.length - 12 }), detail: msg("news.preseason.additionalApproaching") });
  }

  // --- Squad & academy section ---
  entries.push({ key: "squad", label: msg("news.preseason.squad"), detail: msg("news.preseason.professionals", { count: squad.length }) });
  entries.push({ key: "academy", label: msg("news.preseason.academy"), detail: msg("news.preseason.youthPlayers", { count: juniors.length }) });
  const flow = world.mp.pendingPreseasonFlow?.[String(club.id)];
  if (flow) {
    if (flow.promotions > 0) entries.push({ key: "promotions", label: msg("news.preseason.promotions"), detail: msg("news.preseason.promotedCount", { count: flow.promotions }) });
    if (flow.intake > 0) entries.push({ key: "intake", label: msg("news.preseason.intake"), detail: msg("news.preseason.intakeCount", { count: flow.intake }) });
    if (flow.replacements > 0) entries.push({ key: "replacements", label: msg("news.preseason.replacements"), detail: msg("news.preseason.replacementsCount", { count: flow.replacements }) });
  }

  // --- Next fixture ---
  const fixtureLine = nextFixtureLine(world, club.id);
  if (fixtureLine) {
    entries.push({ key: "next-fixture", label: msg("news.preseason.firstFixture"), detail: msg("news.preseason.fixture", { opponent: fixtureLine.opponent, day: fixtureLine.day, context: fixtureLine.venue }) });
  }

  publishNews(world, {
    kind: "season",
    subject: NEWS_SUBJECTS.preseasonReport,
    recipientClubId: club.id,
    headline: "news.preseason.headline",
    body: msg("news.preseason", { division: tier ?? 0, cash: club.cash, count: expiring.length, finance }),
    entries,
  });
}