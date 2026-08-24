import type { Club, NewsEntry, World } from "./types";
import { gameConfig } from "../config";
import { formatMoney, NEWS_SUBJECTS, publishNews } from "./news";
import { activeDivisionForClub, tierOf } from "./multiplayer";
import { getCommitmentTotals, financialState } from "./finance";
import { multiplayerDayLabel } from "./calendar";

/**
 * Pre-season report (news overhaul): one immersive message per human-managed
 * club on the first day of the new season, written at SEASON_ROLLOVER_COMMIT
 * once divisions, budgets, fixtures and academy intake are final. Idempotent
 * per club/season so a retried commit cannot duplicate reports.
 */

const FINANCE_STATUS_LABELS: Record<string, string> = {
  SAFE: "finances are in good order",
  AT_RISK: "financial cushion is under strain",
  NEGATIVE_CASH: "cash position is negative",
};

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

function nextFixtureLine(world: World, clubId: number): string | null {
  let best: { dayIndex: number; homeClubId: number; awayClubId: number } | undefined;
  for (const fixture of world.fixtures) {
    if (fixture.played || (fixture.homeClubId !== clubId && fixture.awayClubId !== clubId)) continue;
    if (!best || fixture.dayIndex < best.dayIndex) best = fixture;
  }
  if (!best) return null;
  const opponentId = best.homeClubId === clubId ? best.awayClubId : best.homeClubId;
  const opponent = world.clubs.find((candidate) => candidate.id === opponentId);
  const venue = best.homeClubId === clubId ? "at home" : "away";
  return `${opponent?.name ?? "TBD"}, ${venue}, ${multiplayerDayLabel(best.dayIndex)}`;
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
    entries.push({ key: "league", label: `Division ${tier}`, detail: `${division.name} · Group ${(division.groupIndex ?? 0) + 1}` });
    if (previous && previous.divisionName === division.name) {
      entries.push({ key: "last-finish", label: "Last season", detail: `Finished ${previous.position} in ${previous.divisionName}` });
    } else if (previous && tier !== null) {
      const previousTier = divisionTier(previous.divisionName);
      const movement = previousTier === null || previousTier === tier
        ? "Regrouped into a new division"
        : previousTier > tier ? "Promoted" : "Relegated";
      entries.push({ key: "last-finish", label: "Last season", detail: `Finished ${previous.position} in ${previous.divisionName}` });
      entries.push({ key: "movement", label: "Movement", detail: movement });
    }
  }

  // --- Finance section ---
  const totals = getCommitmentTotals(world, club);
  entries.push({ key: "cash", label: "Cash", detail: formatMoney(club.cash) });
  entries.push({
    key: "cushion",
    label: "Financial cushion",
    detail: `${formatMoney(totals.financialCushion)} (${FINANCE_STATUS_LABELS[financialState(world, club)] ?? "review required"})`,
  });

  // --- Contract section ---
  const expiring = squad
    .filter((p) => p.loanId === null && p.contractDays <= warningDays)
    .sort((a, b) => a.contractDays - b.contractDays);
  for (const player of expiring.slice(0, 12)) {
    entries.push({ key: `contract:${player.id}`, label: player.name, detail: `${player.contractDays} days remaining on his contract` });
  }
  if (expiring.length > 12) {
    entries.push({ key: "contract-more", label: `+${expiring.length - 12} more`, detail: "additional contracts approaching expiry" });
  }

  // --- Squad & academy section ---
  entries.push({ key: "squad", label: "Senior squad", detail: `${squad.length} professionals` });
  entries.push({ key: "academy", label: "Academy", detail: `${juniors.length} youth players` });
  const flow = world.mp.pendingPreseasonFlow?.[String(club.id)];
  if (flow) {
    if (flow.promotions > 0) entries.push({ key: "promotions", label: "Promotions", detail: `${flow.promotions} youth ${flow.promotions === 1 ? "player" : "players"} stepped up to the senior squad` });
    if (flow.intake > 0) entries.push({ key: "intake", label: "New intake", detail: `${flow.intake} new ${flow.intake === 1 ? "prospect" : "prospects"} joined the academy` });
    if (flow.replacements > 0) entries.push({ key: "replacements", label: "Replacements", detail: `${flow.replacements} senior ${flow.replacements === 1 ? "player" : "players"} arrived to complete the squad` });
  }

  // --- Next fixture ---
  const fixtureLine = nextFixtureLine(world, club.id);
  if (fixtureLine) entries.push({ key: "next-fixture", label: "First fixture", detail: fixtureLine });

  // --- Lead copy ---
  const leagueLead = division && tier !== null ? `The new campaign begins in Division ${tier}.` : "A new campaign is about to begin.";
  const financeLead = `Cash stands at ${formatMoney(club.cash)} and your ${FINANCE_STATUS_LABELS[financialState(world, club)] ?? "finances deserve a review"}.`;
  const contractLead = expiring.length > 0
    ? `${expiring.length === 1 ? "One contract needs" : `${expiring.length} contracts need`} attention before ${expiring.length === 1 ? "its" : "their"} expiry window closes.`
    : "Every senior contract has comfortable runway.";
  const briefingFacts = entries
    .map((entry) => `${entry.label}: ${entry.detail}`)
    .join("; ");

  publishNews(world, {
    kind: "season",
    subject: NEWS_SUBJECTS.preseasonReport,
    recipientClubId: club.id,
    headline: `Season ${world.mp.seasonNumber ?? world.year} briefing: the campaign ahead`,
    text: `${leagueLead} ${financeLead} ${contractLead} The dressing room is ready for the next chapter. Boardroom briefing: ${briefingFacts}.`,
    entries,
  });
}
