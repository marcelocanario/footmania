import type { LiveMatchState, World } from "../game/types";
import { livePhase } from "../game/match";
import { multiplayerDayLabel } from "../game/calendar";
import { FORMATION_NAMES } from "../game/constants";
import { resolveClubKits } from "../game/kits";
import { displayName } from "../game/displayName";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";
import { MP_CONFIG } from "../config";
import { injuryDaysRemaining, conditionLabel } from "../game/energyInjury";

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
}

export interface LivePlayerView {
  id: number;
  name: string;
  displayName: string;
  nickname: string | null;
  position: number;
  tacPos: number;
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

export interface LiveKitView {
  primary: string;
  secondary: string;
  accent: string;
  numberColor: string;
  pattern: string;
}

export interface LiveTacticView {
  style: number;
  pressing: number;
  direction: number;
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
  dateLabel: string;
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
  homeTactics: LiveTacticView;
  awayTactics: LiveTacticView;
  automationDisabled?: [boolean, boolean];
  automationFiredCount?: number;
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
  automationFiredCount: number;
  progressPct: number;
  currentAddedTime: number | null;
}

export function liveStateView(world: World, st: LiveMatchState, viewerUserId?: number | null): LiveStateView {
  const byId = new Map(world.players.map((p) => [p.id, p]));
  const club = (id: number) => world.clubs.find((c) => c.id === id);
  const comp = world.competitions.find((c) => c.id === st.competitionId);
  const home = club(st.homeClubId);
  const away = club(st.awayClubId);
  const fixture = world.fixtures.find((candidate) => candidate.id === st.fixtureId);
  const isDivision = comp?.kind === "division";
  const pv = (id: number): LivePlayerView | null => {
    const p = byId.get(id);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      displayName: displayName(p),
      nickname: p.nickname ?? null,
      position: p.position,
      tacPos: p.tacPos,
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
  }));
  const { progressPct, currentAddedTime } = clockProgress(st);
  // Determine which side the viewer controls (if any).
  const viewerClub = viewerUserId !== undefined && viewerUserId !== null ? world.clubs.find((c) => c.ownerUserId === viewerUserId) : undefined;
  const humanClubId = viewerClub?.id ?? null;
  const homeKits = home ? resolveClubKits(home) : null;
  const awayKits = away ? resolveClubKits(away) : null;
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
    dateLabel: multiplayerDayLabel(world.dayIndex),
    homeClubId: st.homeClubId,
    awayClubId: st.awayClubId,
    home: home?.name ?? "",
    away: away?.name ?? "",
    // Kit Lab: full home/away/GK designs so pitch markers can mirror the
    // pattern; each side's goalkeeper wears the side's GK design.
    homeKit: kitView(homeKits?.home ?? null, "#23a55a", "#14693c"),
    awayKit: kitView(awayKits?.away ?? null, "#f0b429", "#8c6510"),
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
    homeOn: toPlayers(st.homeOn),
    awayOn: toPlayers(st.awayOn),
    homeBench: toPlayers(st.homeSubs),
    awayBench: toPlayers(st.awaySubs),
    usedSubs: st.usedSubs,
    humanSide: humanClubId !== null ? (st.homeClubId === humanClubId ? 0 : 1) : 1,
    isParticipant: humanClubId !== null && (st.homeClubId === humanClubId || st.awayClubId === humanClubId),
    homeManager: home?.coachName ?? "",
    awayManager: away?.coachName ?? "",
    homeFormation: formationName(home),
    awayFormation: formationName(away),
    homeFormationId: home?.tactics?.formation ?? 4,
    awayFormationId: away?.tactics?.formation ?? 4,
    homeTactics: tacticView(st.homeTactics),
    awayTactics: tacticView(st.awayTactics),
    automationDisabled: st.automationDisabled ?? [false, false],
    automationFiredCount: st.automationFiredRuleIds?.length ?? 0,
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
  };
}

function tacticView(tactics: LiveMatchState["homeTactics"]): LiveTacticView {
  return {
    style: tactics.style === "COUNTER" ? 2 : tactics.style === "PRESS" ? 1 : 0,
    pressing: Math.max(0, Math.min(2, Math.round(tactics.pressing * 2))),
    direction: tactics.direction === "WIDE" ? 1 : 0,
  };
}

function formationName(club: { tactics?: { formation: number } } | undefined): string {
  if (!club?.tactics) return "";
  return FORMATION_NAMES[club.tactics.formation] ?? "";
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
export function liveStateDeltaView(world: World, st: LiveMatchState, eventStart: number): LiveStateDeltaView {
  const byId = new Map(world.players.map((p) => [p.id, p]));
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
  }));
  const { progressPct, currentAddedTime } = clockProgress(st);
  return {
    matchId: st.matchId,
    minute: st.minute,
    half: st.half,
    phase: livePhase(st),
    homeScore: st.scores[0],
    awayScore: st.scores[1],
    stats: st.stats,
    newEvents,
    automationFiredCount: st.automationFiredRuleIds?.length ?? 0,
    progressPct,
    currentAddedTime,
  };
}
