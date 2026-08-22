import {
  CalendarClock,
  CalendarRange,
  Coins,
  FileSignature,
  Gavel,
  GraduationCap,
  Hourglass,
  ListChecks,
  type LucideIcon,
  Play,
  RefreshCcw,
  Scale,
  ShieldQuestion,
  Split,
  Swords,
  Trophy,
  Users,
  Flag,
} from "lucide-react";

export type EventCategory = "clock" | "match" | "market" | "finance" | "contract" | "season";

export interface EventCategoryInfo {
  id: EventCategory;
  label: string;
}

/** Display order for category filters. */
export const EVENT_CATEGORIES: EventCategoryInfo[] = [
  { id: "clock", label: "Game clock" },
  { id: "match", label: "Matches" },
  { id: "market", label: "Market" },
  { id: "finance", label: "Finance" },
  { id: "contract", label: "Contracts" },
  { id: "season", label: "Season lifecycle" },
];

export interface EventTypeInfo {
  label: string;
  description: string;
  category: EventCategory;
  icon: LucideIcon;
}

/**
 * Registry mapping every backend ScheduledEventType (backend/src/services/
 * scheduler.ts) to human-readable metadata. Unknown types fall back to the
 * raw enum value so new backend events never render blank.
 */
export const EVENT_CATALOG: Record<string, EventTypeInfo> = {
  GAME_DAY_ADVANCE: {
    label: "Game day advance",
    description: "Heartbeat of the world clock — advances every division to the next game day.",
    category: "clock",
    icon: CalendarClock,
  },
  BEGIN_GAME_DAY: {
    label: "Begin game day",
    description: "Start-of-day processing: energy recovery, player development and inactivity checks for all clubs.",
    category: "clock",
    icon: Play,
  },
  PAYROLL_RUN: {
    label: "Payroll run",
    description: "Pays salaries at a payroll boundary and triggers financial intervention for clubs that go negative.",
    category: "finance",
    icon: Coins,
  },
  WEEKLY_SIM_UPDATE: {
    label: "Weekly simulation",
    description: "Weekly league-wide update plus the contract negotiation cycle.",
    category: "finance",
    icon: RefreshCcw,
  },
  AI_TRANSFER_TICK: {
    label: "AI transfer tick",
    description: "AI clubs scout, bid and list players on the transfer market.",
    category: "market",
    icon: Users,
  },
  AUCTION_END: {
    label: "Auction end",
    description: "Settles a finished auction — awards the player to the highest bidder or returns them to their club.",
    category: "market",
    icon: Gavel,
  },
  LOAN_END: {
    label: "Loan end",
    description: "Returns a player on loan to their parent club.",
    category: "market",
    icon: Hourglass,
  },
  MATCH_START: {
    label: "Match start",
    description: "Kicks off a scheduled fixture and opens it as a live match.",
    category: "match",
    icon: Flag,
  },
  MATCH_COMPLETE: {
    label: "Match complete",
    description: "Resolves a live match: final score, ratings, injuries and suspensions.",
    category: "match",
    icon: Swords,
  },
  CONTRACT_WARNING: {
    label: "Contract warning",
    description: "Notifies clubs whose players are approaching contract expiry.",
    category: "contract",
    icon: ShieldQuestion,
  },
  CONTRACT_EXPIRE: {
    label: "Contract expire",
    description: "Expires un-renewed contracts and releases those players onto the free-agent market.",
    category: "contract",
    icon: FileSignature,
  },
  CONTRACT_END_PROCESSING: {
    label: "Contract end processing",
    description: "Season-boundary sweep that finalizes all remaining contract expiries before rollover.",
    category: "contract",
    icon: ListChecks,
  },
  SEASON_RESULTS_FINALIZE: {
    label: "Season results finalize",
    description: "Archives final standings, statistics and history for the ending season.",
    category: "season",
    icon: Trophy,
  },
  INTERSEASON_START: {
    label: "Inter-season start",
    description: "Begins the break between seasons after the post-match buffer days.",
    category: "season",
    icon: CalendarRange,
  },
  PROMOTION_RELEGATION: {
    label: "Promotion & relegation",
    description: "Applies promotions and relegations based on final standings.",
    category: "season",
    icon: Split,
  },
  DIVISION_RESTRUCTURE: {
    label: "Division restructure",
    description: "Rebuilds divisions and fills empty slots so every club has a home for next season.",
    category: "season",
    icon: Scale,
  },
  WAITING_POOL_ASSIGNMENT: {
    label: "Waiting pool assignment",
    description: "Assigns managers in the waiting pool to vacant AI clubs.",
    category: "season",
    icon: Users,
  },
  NEXT_SEASON_BUDGET_ALLOCATION: {
    label: "Next-season budget allocation",
    description: "Issues starting cash and budget allocations for the upcoming season.",
    category: "season",
    icon: Coins,
  },
  SEASONAL_ACADEMY_INTAKE: {
    label: "Academy intake",
    description: "Generates the new youth-intake class for every academy.",
    category: "season",
    icon: GraduationCap,
  },
  NEXT_SEASON_FIXTURE_GENERATION: {
    label: "Fixture generation",
    description: "Generates the full round-robin fixture calendar for next season.",
    category: "season",
    icon: CalendarRange,
  },
  NEXT_SEASON_STRUCTURE_VALIDATE: {
    label: "Structure validation",
    description: "Validates divisions, fixtures and club counts before the season goes live.",
    category: "season",
    icon: ListChecks,
  },
  NEXT_SEASON_PREPARATION_OPEN: {
    label: "Preparation window open",
    description: "Opens the pre-season preparation window where managers finalize squads and lineups.",
    category: "season",
    icon: CalendarRange,
  },
  SEASON_ROLLOVER: {
    label: "Season rollover",
    description: "Runs the rollover workflow that transitions the world into the next season.",
    category: "season",
    icon: RefreshCcw,
  },
  SEASON_ROLLOVER_COMMIT: {
    label: "Season rollover commit",
    description: "Commits the completed rollover and activates the new season.",
    category: "season",
    icon: Trophy,
  },
};

const UNKNOWN_ICON = ListChecks;

export function eventInfo(type: string): EventTypeInfo {
  return (
    EVENT_CATALOG[type] ?? {
      label: type.replaceAll("_", " ").toLowerCase(),
      description: "Unrecognized scheduler event type.",
      category: "season",
      icon: UNKNOWN_ICON,
    }
  );
}

export const EVENT_STATUS_META: Record<string, { label: string; tone: "info" | "running" | "done" | "failed" | "cancelled" }> = {
  PENDING: { label: "Pending", tone: "info" },
  RUNNING: { label: "Running", tone: "running" },
  COMPLETED: { label: "Completed", tone: "done" },
  FAILED: { label: "Failed", tone: "failed" },
  CANCELLED: { label: "Cancelled", tone: "cancelled" },
};

export function eventStatusMeta(status: string) {
  return EVENT_STATUS_META[status] ?? { label: status, tone: "info" as const };
}
