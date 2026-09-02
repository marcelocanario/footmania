import type { LiveBallAction, LiveMatchState, Player, World } from "../game/types";
import { livePhase, tacticsCooldownMinutesRemaining } from "../game/match";
import { EVENT_CODES, STYLE_NAMES, PRESSING_NAMES, DIRECTION_NAMES } from "../game/constants";
import { formationById } from "../game/formations";
import {
  canonicalFromLive,
  decayedStoredFamiliarity,
  projectSetups,
} from "../game/familiarity";
import { resolveClubKits, selectMatchKits } from "../game/kits";
import { displayName } from "../game/displayName";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";
import { MP_CONFIG } from "../config";
import { injuryDaysRemaining, conditionLabel } from "../game/energyInjury";
import { liveRatingFromAccum, primaryCoarseRole } from "../game/matchRatings";

/** Base scoreboard row shape (kept for API compatibility). */
interface PlayerMatchScore {
  playerId: number;
  clubId: number;
  goals: number;
  assists: number;
  score: number;
  won: boolean;
  minutes: number;
}

/** Player score row for the live "Scores" tab. */
export interface LivePlayerScoreView extends PlayerMatchScore {
  name: string;
  /** Coarse deployed role for the current rating. */
  role?: string;
  /** True when this is a live rating (from the accumulator), not a points
   *  score. */
  live?: boolean;
  /** Live 3.0–10.0 rating; null before 10 match-minutes. */
  rating?: number | null;
}

/** Build the live scoreboard from the rating accumulator (plan §17): each
 *  on-pitch player's live 3.0–10.0 rating (null until 10 match-minutes),
 *  sorted best first. Replaces the old points scoreboard. */
function liveRatingsView(world: World, st: LiveMatchState, byId: Map<number, Player>): LivePlayerScoreView[] {
  const seasonId = world.mp.seasonId;
  const calibration: Record<string, import("../game/types").RoleCalibrationEntry> | undefined = (() => {
    const cals = (world.roleCalibrations ?? []).filter((c) => c.seasonId === seasonId);
    if (cals.length === 0) return undefined;
    const out: Record<string, import("../game/types").RoleCalibrationEntry> = {};
    for (const c of cals) out[c.role] = c;
    return out;
  })();
  const out: LivePlayerScoreView[] = [];
  for (const [pid, accum] of Object.entries(st.ratingAccum ?? {})) {
    const playerId = Number(pid);
    const p = byId.get(playerId);
    if (!p) continue;
    const rating = liveRatingFromAccum(accum, calibration);
    out.push({
      playerId,
      clubId: accum.clubId,
      goals: 0,
      assists: 0,
      score: rating ?? 0,
      won: false,
      minutes: Math.round(accum.roleSecondsTotal / 60),
      name: displayName(p),
      role: primaryCoarseRole(accum),
      live: true,
      rating,
    });
  }
  return out.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.playerId - b.playerId);
}

export interface LiveEventView {
  sequence: number;
  minute: number;
  half: number;
  type: number;
  subtype: number;
  clubId: number;
  playerId: number | null;
  player2Id: number | null;
  player: string;
  player2: string;
  addedTime?: number;
  /** Injury events carry the estimated days out here. */
  goalType?: number;
}

export interface LivePlayerView {
  id: number;
  name: string;
  displayName: string;
  nickname: string | null;
  naturalPosition: string;
  slotIndex: number | null;
  deployedRole: string | null;
  /** Squad shirt number shown on the pitch marker. */
  number: number | null;
  overall: number;
  energy: number;
  injuryDays: number;
  injuryDaysRemaining: number;
  injuryCause: "MATCH" | "TRAINING" | null;
  injuryUntilAbsoluteGameDay: number | null;
  conditionLabel: string;
  suspended: boolean;
}

/**
 * A player missing from the pitch with cause: sent off (RED) or injured while
 * no substitution slot/candidate remained (INJURY). Auto-subbed injuries do
 * not appear — their SUB event removes them from this projection. The pitch
 * uses this projection for short-handed status only; absent players are not
 * rendered as on-pitch markers.
 */
export interface LiveMissingPlayerView {
  /** 0 = home, 1 = away. */
  side: 0 | 1;
  playerId: number;
  name: string;
  /** Squad shirt number for the short-handed status. */
  number: number | null;
  kind: "INJURY" | "RED";
  slotIndex: number | null;
  deployedRole: string | null;
}

export interface LiveKitView {
  primary: string;
  secondary: string;
  accent: string;
  numberColor: string;
  pattern: string;
}

export interface TacticProjectionView {
  style: number;
  pressing: number;
  direction: number;
  /** Projected post-switch familiarity for that combination. */
  familiarity: number;
}

export interface LiveTacticView {
  style: number;
  pressing: number;
  direction: number;
  /** plans/6 §17: this side's in-match familiarity with its current setup
   *  (kickoff snapshot, reduced by any live switch penalties taken so far). */
  familiarity: number;
  /** Server-computed switch-transfer projection for every style/pressing/
   *  direction combination at this side's current formation. */
  projections: TacticProjectionView[];
}

/**
 * Possession projection for the live pitch ball (read straight off the
 * possession-state engine's persisted runtime fields). The carrier and action
 * participants are presentation-only identities selected by the simulator;
 * they never affect match calculations.
 */
export interface LiveBallView {
  /** Possessing team index: 0 = home, 1 = away. */
  side: 0 | 1;
  zone: string;
  phase: string;
  startType: string;
  counter: boolean;
  /** Stable on-pitch carrier for the current possession. */
  carrierId: number | null;
  /** Last resolved possession action (PASS/CROSS/CARRY/DRIBBLE/SHOT) and the
   *  zone it started from; lets the client draw turnover intent lines. Null on
   *  live states persisted before the engine tracked them. */
  lastAction: string | null;
  prevZone: string | null;
  /** Participants for the last resolved action, when available. */
  lastBallAction: LiveBallAction | null;
}

export interface LiveStateView {
  matchId: number;
  fixtureId: number;
  competitionId: number;
  competitionName: string;
  competitionKind: string;
  seasonNumber: number | null;
  divisionTier: number | null;
  groupNumber: number | null;
  roundNumber: number | null;
  stadiumName: string;
  dayIndex: number;
  homeClubId: number;
  awayClubId: number;
  home: string;
  away: string;
  homeKit: LiveKitView;
  awayKit: LiveKitView;
  homeGkKit: LiveKitView;
  awayGkKit: LiveKitView;
  homeScore: number;
  awayScore: number;
  minute: number;
  half: number;
  phase: string;
  extraTime: boolean;
  ended: boolean;
  shootout: { scores: [number, number]; winner: string } | null;
  stats: LiveMatchState["stats"];
  events: LiveEventView[];
  /** Per-player MVP scores (goals*2 + assists + win bonus) for the current
   *  state of the match; only players with pitch minutes appear. */
  scores: LivePlayerScoreView[];
  homeOn: LivePlayerView[];
  awayOn: LivePlayerView[];
  homeBench: LivePlayerView[];
  awayBench: LivePlayerView[];
  usedSubs: [number, number];
  humanSide: number;
  /** True when the viewer's own club is playing; spectators get read-only UI. */
  isParticipant: boolean;
  homeManager: string;
  awayManager: string;
  homeFormation: string;
  awayFormation: string;
  homeFormationId: number;
  awayFormationId: number;
  homeFormationSlots: FormationSlotView[];
  awayFormationSlots: FormationSlotView[];
  homeTactics: LiveTacticView;
  awayTactics: LiveTacticView;
  /** Live-match tactics lock: match-minutes remaining per side (0 = unlocked). */
  homeTacticsCooldownMinutes: number;
  awayTacticsCooldownMinutes: number;
  automationDisabled?: [boolean, boolean];
  automationFiredCount?: number;
  automationLog?: AutomationLogEntryView[];
  // New: match progress + halftime + added time
  progressPct: number;
  coinTossWinner: 0 | 1;
  firstHalfAddedMinutes: number;
  secondHalfAddedMinutes: number;
  halftimeStartedAt: number | null;
  halftimeReady: [boolean, boolean];
  halftimePauseMinutes: number;
  currentAddedTime?: number | null;
  homeIsHuman: boolean;
  awayIsHuman: boolean;
  /** Players absent from the pitch (red cards; unreplaced injuries). */
  missingPlayers: LiveMissingPlayerView[];
  ball: LiveBallView;
}

/** §15.3 slot shape shared by lineup, full live views and live deltas. */
export interface FormationSlotView {
  index: number;
  key: string;
  role: string;
  lane: string;
  line: string;
  x: number;
  y: number;
  label: string;
}

function formationSlotViews(formationId: number): FormationSlotView[] {
  return (formationById(formationId)?.slots ?? []).map((slot, index) => ({
    index, key: slot.key, role: slot.role, lane: slot.lane, line: slot.line, x: slot.x, y: slot.y, label: slot.label,
  }));
}

export interface LiveStateDeltaView {
  matchId: number;
  minute: number;
  half: number;
  phase: string;
  homeScore: number;
  awayScore: number;
  stats: LiveMatchState["stats"];
  newEvents: LiveEventView[];
  /** Per-player MVP scores for the current state (recomputed on every delta so
   *  the live Scores tab updates as goals/assists happen). */
  scores: LivePlayerScoreView[];
  automationFiredCount: number;
  automationLog: AutomationLogEntryView[];
  progressPct: number;
  currentAddedTime: number | null;
  homeTacticsCooldownMinutes: number;
  awayTacticsCooldownMinutes: number;
  /** Cards, injuries and substitutions can change rosters without a phase
   *  change, so deltas carry the authoritative current roster lists. */
  homeOn: LivePlayerView[];
  awayOn: LivePlayerView[];
  homeBench: LivePlayerView[];
  awayBench: LivePlayerView[];
  usedSubs: [number, number];
  /** Full missing-player snapshot each delta so the pitch stays correct
   *  between full-state pushes. */
  missingPlayers: LiveMissingPlayerView[];
  ball: LiveBallView;
  /** §15.4: present ONLY when either side's formation changed since the prior
   *  emitted state, so the pitch never renders stale slot geometry. Omitted
   *  entirely on an unchanged delta. */
  homeFormation?: string;
  awayFormation?: string;
  homeFormationId?: number;
  awayFormationId?: number;
  homeFormationSlots?: FormationSlotView[];
  awayFormationSlots?: FormationSlotView[];
}

/**
 * The only two fields of `LiveStateView` that vary per viewer: which side (if
 * any) they control, and whether they're a participant. Everything else in
 * the view (kits, formations, roster, events, stats) is identical for every
 * spectator of the same match, so callers broadcasting to many sockets for
 * one match can compute the rest once and patch just these two fields in.
 */
export function viewerFieldsFor(world: World, st: LiveMatchState, viewerUserId?: number | null): { humanSide: 0 | 1; isParticipant: boolean } {
  const viewerClub = viewerUserId !== undefined && viewerUserId !== null ? world.clubs.find((c) => c.ownerUserId === viewerUserId) : undefined;
  const humanClubId = viewerClub?.id ?? null;
  return {
    humanSide: humanClubId !== null ? (st.homeClubId === humanClubId ? 0 : 1) : 1,
    isParticipant: humanClubId !== null && (st.homeClubId === humanClubId || st.awayClubId === humanClubId),
  };
}

/** One entry of the private per-side automation outcome log (plan §11).
 *  `reason` is an AUTOMATION_REASON code (game/constants.ts) resolved to a
 *  message client-side via i18n — never prose over the wire. Deliberately
 *  carries no rule name/preset name: presets are loaded on demand and never
 *  held by this read-only view layer (Part 4), so the log identifies a rule
 *  only by its opaque (presetId, ruleId) pair. */
export interface AutomationLogEntryView {
  presetId: string;
  ruleId: string;
  /** Which action within the rule this entry reports on (a rule may now
   *  queue several). Absent for a RETIRED entry, which speaks for the whole
   *  rule. */
  actionIndex?: number;
  minute: number;
  status: "APPLIED" | "SKIPPED" | "RETIRED";
  reason?: number;
}

/** Automation log filtered to the viewer's own side — never exposed to an
 *  opponent or spectator, the same privacy footing as hidden player quality. */
export function automationLogViewFor(st: LiveMatchState, humanSide: 0 | 1, isParticipant: boolean): AutomationLogEntryView[] {
  if (!isParticipant) return [];
  return (st.automationLog ?? [])
    .filter((e) => e.side === humanSide)
    .map((e) => ({ presetId: e.presetId, ruleId: e.ruleId, actionIndex: e.actionIndex, minute: e.minute, status: e.status, reason: e.reason }));
}

/** Count of successfully applied rules for the viewer's own side — the
 *  automationFiredCount field predates per-rule logging and is kept for
 *  compatibility; it now derives from the log rather than the legacy
 *  fired-id set (which stops growing once maxFires ships new matches). */
export function automationFiredCountFor(st: LiveMatchState, humanSide: 0 | 1, isParticipant: boolean): number {
  if (!isParticipant) return 0;
  return (st.automationLog ?? []).filter((e) => e.side === humanSide && e.status === "APPLIED").length;
}

function livePlayerView(world: World, st: LiveMatchState, byId: Map<number, Player>, id: number): LivePlayerView | null {
  const p = byId.get(id);
  if (!p) return null;
  const gameDay = world.mp.absoluteGameDay ?? world.dayIndex;
  // Resolve live slot assignment if present
  const homeSlot = (st as unknown as { homeSlotByPlayerId?: Record<number, number> }).homeSlotByPlayerId?.[p.id];
  const awaySlot = (st as unknown as { awaySlotByPlayerId?: Record<number, number> }).awaySlotByPlayerId?.[p.id];
  const slotIndex = homeSlot ?? awaySlot ?? null;
  let deployedRole: string | null = null;
  if (slotIndex !== null) {
    const isHome = homeSlot !== undefined;
    const formationId = isHome ? st.homeTactics.formation : st.awayTactics.formation;
    const def = formationById(formationId);
    if (def && def.slots[slotIndex]) deployedRole = def.slots[slotIndex].role;
  }
  return {
    id: p.id,
    name: p.name,
    displayName: displayName(p),
    nickname: p.nickname ?? null,
    naturalPosition: p.position as unknown as string,
    slotIndex,
    deployedRole,
    number: p.squadNumber ?? null,
    overall: p.overall,
    energy: st.playerEnergy?.[p.id] ?? p.energy,
    injuryDays: injuryDaysRemaining(p, gameDay),
    injuryDaysRemaining: injuryDaysRemaining(p, gameDay),
    injuryCause: p.injuryCause ?? null,
    injuryUntilAbsoluteGameDay: p.injuryUntilAbsoluteGameDay ?? null,
    conditionLabel: conditionLabel(p, gameDay),
    suspended: p.suspendedGames > 0,
  };
}

export function liveStateView(world: World, st: LiveMatchState, viewerUserId?: number | null): LiveStateView {
  // Only the two rostered clubs' players are ever referenced below (roster
  // lists, events, cards, injuries); no need to index every player in the
  // world for a single match's lookup.
  const byId = new Map(world.players.filter((p) => p.clubId === st.homeClubId || p.clubId === st.awayClubId).map((p) => [p.id, p]));
  const club = (id: number) => world.clubs.find((c) => c.id === id);
  const comp = world.competitions.find((c) => c.id === st.competitionId);
  const home = club(st.homeClubId);
  const away = club(st.awayClubId);
  const fixture = world.fixtures.find((candidate) => candidate.id === st.fixtureId);
  const isDivision = comp?.kind === "division";
  const pv = (id: number): LivePlayerView | null => {
    const p = byId.get(id);
    if (!p) return null;
    const homeSlot = (st as unknown as { homeSlotByPlayerId?: Record<number, number> }).homeSlotByPlayerId?.[p.id];
    const awaySlot = (st as unknown as { awaySlotByPlayerId?: Record<number, number> }).awaySlotByPlayerId?.[p.id];
    const slotIndex = homeSlot ?? awaySlot ?? null;
    let deployedRole: string | null = null;
    if (slotIndex !== null) {
      const isHome = homeSlot !== undefined;
      const formationId = isHome ? st.homeTactics.formation : st.awayTactics.formation;
      const def = formationById(formationId);
      if (def && def.slots[slotIndex]) deployedRole = def.slots[slotIndex].role;
    }
    return {
      id: p.id,
      name: p.name,
      displayName: displayName(p),
      nickname: p.nickname ?? null,
      naturalPosition: p.position as unknown as string,
      slotIndex,
      deployedRole,
      number: p.squadNumber ?? null,
      overall: p.overall,
       energy: st.playerEnergy?.[p.id] ?? p.energy,
       injuryDays: injuryDaysRemaining(p, world.mp.absoluteGameDay ?? world.dayIndex),
       injuryDaysRemaining: injuryDaysRemaining(p, world.mp.absoluteGameDay ?? world.dayIndex),
       injuryCause: p.injuryCause ?? null,
       injuryUntilAbsoluteGameDay: p.injuryUntilAbsoluteGameDay ?? null,
       conditionLabel: conditionLabel(p, world.mp.absoluteGameDay ?? world.dayIndex),
      suspended: p.suspendedGames > 0,
    };
  };
  const toPlayers = (ids: number[]): LivePlayerView[] => ids.map(pv).filter((p): p is LivePlayerView => !!p);
  const events: LiveEventView[] = st.events.map((e, sequence) => ({
    sequence,
    minute: e.minute,
    half: e.half,
    type: e.type,
    subtype: e.subtype,
    clubId: e.clubId,
    playerId: e.playerId,
    player2Id: e.player2Id,
    player: e.playerId ? (byId.get(e.playerId) ? displayName(byId.get(e.playerId)!) : "") : "",
    player2: e.player2Id ? (byId.get(e.player2Id) ? displayName(byId.get(e.player2Id)!) : "") : "",
    ...(e.addedTime !== undefined ? { addedTime: e.addedTime } : {}),
    ...(e.type === EVENT_CODES.INJURY ? { goalType: e.goalType } : {}),
  }));
  const { progressPct, currentAddedTime } = clockProgress(st);
  const { humanSide, isParticipant } = viewerFieldsFor(world, st, viewerUserId);
  const homeKits = home ? resolveClubKits(home) : null;
  const awayKits = away ? resolveClubKits(away) : null;
  // Automatic uniform selection: contrast-aware pick of each side's designs,
  // so the pitch never shows two clashing shells when designs allow a better
  // pairing. GK kits are fixed per side regardless of the outfield choice.
  const { homeKit, awayKit } = homeKits && awayKits ? selectMatchKits(homeKits, awayKits) : { homeKit: null, awayKit: null };
  return {
    matchId: st.matchId,
    fixtureId: st.fixtureId,
    competitionId: st.competitionId,
    competitionName: comp?.name ?? "",
    competitionKind: comp?.kind ?? st.compKind,
    seasonNumber: world.mp.seasonNumber ?? null,
    divisionTier: isDivision ? (comp?.tier ?? 1) : null,
    groupNumber: isDivision ? ((comp?.groupIndex ?? 0) + 1) : null,
    roundNumber: fixture ? fixture.round + 1 : null,
    stadiumName: home?.stadiumName ?? "",
    dayIndex: world.dayIndex,
    homeClubId: st.homeClubId,
    awayClubId: st.awayClubId,
    home: home?.name ?? "",
    away: away?.name ?? "",
    // Kit Lab: full home/away/GK designs so pitch markers can mirror the
    // pattern; each side's goalkeeper wears the side's GK design. The
    // outfield pair is chosen by selectMatchKits (contrast-aware).
    homeKit: kitView(homeKit ?? null, "#23a55a", "#14693c"),
    awayKit: kitView(awayKit ?? null, "#f0b429", "#8c6510"),
    homeGkKit: kitView(homeKits?.gk ?? null, "#d4770f", "#8a4d09"),
    awayGkKit: kitView(awayKits?.gk ?? null, "#0e6ba8", "#084a75"),
    homeScore: st.scores[0],
    awayScore: st.scores[1],
    minute: st.minute,
    half: st.half,
    phase: livePhase(st),
    extraTime: st.extraTimePlayed,
    ended: st.ended,
    shootout: st.shootout
      ? { scores: st.shootout.scores, winner: club(st.shootout.winner)?.name ?? "" }
      : null,
    stats: st.stats,
    events,
    scores: liveRatingsView(world, st, byId),
    homeOn: toPlayers(st.homeOn),
    awayOn: toPlayers(st.awayOn),
    homeBench: toPlayers(st.homeSubs),
    awayBench: toPlayers(st.awaySubs),
    usedSubs: st.usedSubs,
    humanSide,
    isParticipant,
    homeManager: home?.coachName ?? "",
    awayManager: away?.coachName ?? "",
    homeFormation: formationById(st.homeTactics.formation)?.name ?? formationName(home),
    awayFormation: formationById(st.awayTactics.formation)?.name ?? formationName(away),
    homeFormationId: st.homeTactics.formation ?? home?.tactics?.formation ?? 4,
    awayFormationId: st.awayTactics.formation ?? away?.tactics?.formation ?? 4,
    homeFormationSlots: formationSlotViews(st.homeTactics.formation),
    awayFormationSlots: formationSlotViews(st.awayTactics.formation),
    homeTactics: tacticSideView(st.homeTactics, home, world.mp.absoluteGameDay ?? world.dayIndex),
    awayTactics: tacticSideView(st.awayTactics, away, world.mp.absoluteGameDay ?? world.dayIndex),
    // Live-match tactics lock (match-minutes left per side) so clients can
    // disable Apply and show a countdown.
    homeTacticsCooldownMinutes: tacticsCooldownMinutesRemaining(st, 0),
    awayTacticsCooldownMinutes: tacticsCooldownMinutesRemaining(st, 1),
    automationDisabled: st.automationDisabled ?? [false, false],
    automationFiredCount: automationFiredCountFor(st, humanSide, isParticipant),
    automationLog: automationLogViewFor(st, humanSide, isParticipant),
    progressPct,
    coinTossWinner: (st.coinTossWinner ?? 0) as 0 | 1,
    firstHalfAddedMinutes: st.firstHalfAddedMinutes ?? 0,
    secondHalfAddedMinutes: st.secondHalfAddedMinutes ?? 0,
    halftimeStartedAt: st.halftimeStartedAt ?? null,
    halftimeReady: st.halftimeReady ?? [false, false],
    halftimePauseMinutes: MP_CONFIG.halftimePauseMinutes,
    currentAddedTime,
    homeIsHuman: !!home?.ownerUserId,
    awayIsHuman: !!away?.ownerUserId,
    missingPlayers: missingPlayersView(st, byId),
    ball: ballView(st),
  };
}

/**
 * Players currently absent from the pitch: red-carded, or injured with no
 * substitution slot/candidate left (plan 9 §17 step 7). Injuries that were
 * auto-subbed emit a normal SUB event whose outId is the injured player, so
 * they drop out of this projection. Side comes from roster membership, and the
 * view retains the last slot the player occupied.
 */
function missingPlayersView(st: LiveMatchState, byId: Map<number, Player>): LiveMissingPlayerView[] {
  const subbedOut = new Set(st.events.filter((event) => event.type === EVENT_CODES.SUB).map((event) => event.playerId));
  const entries = new Map<number, LiveMissingPlayerView>();
  const add = (playerId: number, kind: "INJURY" | "RED") => {
    if (subbedOut.has(playerId) || entries.has(playerId)) return;
    const p = byId.get(playerId);
    if (!p) return;
    const slotIndex = (st as unknown as { homeSlotByPlayerId?: Record<number, number>; awaySlotByPlayerId?: Record<number, number> }).homeSlotByPlayerId?.[playerId] ?? (st as unknown as { awaySlotByPlayerId?: Record<number, number> }).awaySlotByPlayerId?.[playerId] ?? null;
    let deployedRole: string | null = null;
    if (slotIndex !== null) {
      const isHome = p.clubId === st.homeClubId;
      const formationId = isHome ? st.homeTactics.formation : st.awayTactics.formation;
      const def = formationById(formationId);
      if (def && def.slots[slotIndex]) deployedRole = def.slots[slotIndex].role;
    }
    entries.set(playerId, {
      side: p.clubId === st.homeClubId ? 0 : 1,
      playerId,
      name: displayName(p),
      number: p.squadNumber ?? null,
      kind,
      slotIndex,
      deployedRole,
    });
  };
  for (const card of st.cards ?? []) {
    if (card.kind === "RED" || card.kind === "YELLOW_RED") add(card.playerId, "RED");
  }
  for (const injury of st.injuries ?? []) add(injury.playerId, "INJURY");
  return Array.from(entries.values()).sort((a, b) => a.side - b.side || (a.slotIndex ?? -1) - (b.slotIndex ?? -1) || a.playerId - b.playerId);
}

function tacticView(tactics: LiveMatchState["homeTactics"]): LiveTacticView {
  return {
    style: tactics.style === "COUNTER" ? 2 : tactics.style === "PRESS" ? 1 : 0,
    pressing: Math.max(0, Math.min(2, Math.round(tactics.pressing * 2))),
    direction: tactics.direction === "WIDE" ? 1 : 0,
    familiarity: 50,
    projections: [],
  };
}

/** Full tactics view for one side: current in-match familiarity plus §17
 *  switch-transfer projections for every combination at the side's formation,
 *  seeded from the owning club's persistent per-setup progress map. */
function tacticSideView(
  tactics: LiveMatchState["homeTactics"],
  club: World["clubs"][number] | undefined,
  absoluteGameDay?: number
): LiveTacticView {
  const view = tacticView(tactics);
  view.familiarity = Math.round(tactics.familiarity);
  const map = club?.tacticFamiliarity ?? null;
  view.projections = projectSetups(
    tactics.familiarity,
    canonicalFromLive(tactics),
    tactics.formation,
    STYLE_NAMES.length,
    PRESSING_NAMES.length,
    DIRECTION_NAMES.length,
    // Keys use the club-scale integers (pressing loop index), matching the
    // format written by the persistent /club/tactics path.
    (style, pressing, direction) =>
      decayedStoredFamiliarity(map, `${tactics.formation}-${style}-${pressing}-${direction}`, absoluteGameDay)
  );
  return view;
}

function formationName(club: { tactics?: { formation: number } } | undefined): string {
  if (!club?.tactics) return "";
  return formationById(club.tactics.formation)?.name ?? "";
}

/** Possession projection shared by the full view and deltas. Falls back to a
 * neutral kickoff state for live states persisted before the possession-state
 * engine runtime existed. */
function ballView(st: LiveMatchState): LiveBallView {
  const side = (st.withBall === 1 ? 1 : 0) as 0 | 1;
  return {
    side,
    zone: st.zone ?? "DEF_CENTRAL",
    phase: st.phase ?? "BUILD_UP",
    startType: st.possessionStartType ?? "KICK_OFF",
    counter: !!st.isCounter,
    carrierId: st.ballCarrierId ?? null,
    lastAction: st.lastAction ?? null,
    prevZone: st.prevZone ?? null,
    lastBallAction: st.lastBallAction ? { ...st.lastBallAction } : null,
  };
}

/** Project a stored design onto the live view, with placeholders for missing clubs. */
function kitView(design: LiveKitView | null, fallbackPrimary: string, fallbackSecondary: string): LiveKitView {
  return {
    primary: design?.primary ?? fallbackPrimary,
    secondary: design?.secondary ?? fallbackSecondary,
    accent: design?.accent ?? "#ffffff",
    numberColor: design?.numberColor ?? "#ffffff",
    pattern: design?.pattern ?? "solid",
  };
}

/**
 * Wall-clock progress projection shared by the full view and deltas so both
 * cannot drift apart: regulation-relative progress and the stoppage-time
 * minute currently being played (null outside added time).
 */
function clockProgress(st: LiveMatchState): { progressPct: number; currentAddedTime: number | null } {
  const firstAdded = st.firstHalfAddedMinutes ?? 0;
  const secondAdded = st.secondHalfAddedMinutes ?? 0;
  const clock = st.matchClockSeconds ?? 0;
  const effectiveClock = st.period === 2 && clock >= MS.timing.firstHalfEndSeconds + firstAdded * 60
    ? clock - firstAdded * 60
    : clock;
  const progressPct = Math.min(100, Math.max(0, effectiveClock / MS.timing.regulationSeconds * 100));
  let currentAddedTime: number | null = null;
  const firstEnd = MS.timing.firstHalfEndSeconds;
  const secondEnd = MS.timing.regulationSeconds + firstAdded * 60;
  if (firstAdded > 0 && clock >= firstEnd && clock < firstEnd + firstAdded * 60 && st.period === 1) {
    currentAddedTime = Math.floor((clock - firstEnd) / 60) + 1;
  } else if (secondAdded > 0 && clock >= secondEnd && clock < secondEnd + secondAdded * 60 && st.period === 2) {
    currentAddedTime = Math.floor((clock - secondEnd) / 60) + 1;
  }
  return { progressPct, currentAddedTime };
}

/** Compact, viewer-neutral update used during server-driven live play. */
export function liveStateDeltaView(
  world: World,
  st: LiveMatchState,
  eventStart: number,
  priorFormations?: { home: number; away: number },
): LiveStateDeltaView {
  // Same narrowing as liveStateView: only the two rostered clubs' players are
  // ever referenced (new events, cards, injuries).
  const byId = new Map(world.players.filter((p) => p.clubId === st.homeClubId || p.clubId === st.awayClubId).map((p) => [p.id, p]));
  const newEvents = st.events.slice(Math.max(0, eventStart)).map((e, offset) => ({
    sequence: Math.max(0, eventStart) + offset,
    minute: e.minute,
    half: e.half,
    type: e.type,
    subtype: e.subtype,
    clubId: e.clubId,
    playerId: e.playerId,
    player2Id: e.player2Id,
    player: e.playerId ? (byId.get(e.playerId) ? displayName(byId.get(e.playerId)!) : "") : "",
    player2: e.player2Id ? (byId.get(e.player2Id) ? displayName(byId.get(e.player2Id)!) : "") : "",
    ...(e.addedTime !== undefined ? { addedTime: e.addedTime } : {}),
    ...(e.type === EVENT_CODES.INJURY ? { goalType: e.goalType } : {}),
  }));
  const toPlayers = (ids: number[]): LivePlayerView[] => ids
    .map((id) => livePlayerView(world, st, byId, id))
    .filter((p): p is LivePlayerView => !!p);
  const { progressPct, currentAddedTime } = clockProgress(st);
  const scores = liveRatingsView(world, st, byId);
  // §15.4: carry the full formation identity + slot geometry whenever either
  // side changed formation since the last state the client saw.
  const formationChanged =
    priorFormations !== undefined &&
    (priorFormations.home !== st.homeTactics.formation || priorFormations.away !== st.awayTactics.formation);
  const formationFields = formationChanged
    ? {
        homeFormation: formationById(st.homeTactics.formation)?.name ?? "",
        awayFormation: formationById(st.awayTactics.formation)?.name ?? "",
        homeFormationId: st.homeTactics.formation,
        awayFormationId: st.awayTactics.formation,
        homeFormationSlots: formationSlotViews(st.homeTactics.formation),
        awayFormationSlots: formationSlotViews(st.awayTactics.formation),
      }
    : {};
  return {
    ...formationFields,
    matchId: st.matchId,
    minute: st.minute,
    half: st.half,
    phase: livePhase(st),
    homeScore: st.scores[0],
    awayScore: st.scores[1],
    stats: st.stats,
    newEvents,
    scores,
    // Placeholders — automation is per-side private data and this delta is
    // computed once and broadcast identically to every socket (unlike the
    // full liveStateView, which is patched per-viewer below). ws.ts's
    // broadcastLiveMatchUpdates overwrites both fields per socket using
    // automationFiredCountFor/automationLogViewFor before sending.
    automationFiredCount: 0,
    automationLog: [],
    progressPct,
    currentAddedTime,
    homeTacticsCooldownMinutes: tacticsCooldownMinutesRemaining(st, 0),
    awayTacticsCooldownMinutes: tacticsCooldownMinutesRemaining(st, 1),
    homeOn: toPlayers(st.homeOn),
    awayOn: toPlayers(st.awayOn),
    homeBench: toPlayers(st.homeSubs),
    awayBench: toPlayers(st.awaySubs),
    usedSubs: st.usedSubs,
    missingPlayers: missingPlayersView(st, byId),
    ball: ballView(st),
  };
}