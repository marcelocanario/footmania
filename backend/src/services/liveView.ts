import type { LiveMatchState, World } from "../game/types";
import { livePhase } from "../game/match";
import { multiplayerDayLabel } from "../game/calendar";
import { FORMATION_NAMES } from "../game/constants";
import { resolveClubKits } from "../game/kits";
import { displayName } from "../game/displayName";

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
}

export interface LivePlayerView {
  id: number;
  name: string;
  displayName: string;
  nickname: string | null;
  position: number;
  tacPos: number;
  overall: number;
  energy: number;
  injuryDays: number;
  suspended: boolean;
}

export interface LiveStateView {
  matchId: number;
  fixtureId: number;
  competitionId: number;
  competitionName: string;
  dateLabel: string;
  homeClubId: number;
  awayClubId: number;
  home: string;
  away: string;
  homeKit: { primary: string; secondary: string; accent: string; numberColor: string; pattern: string };
  awayKit: { primary: string; secondary: string; accent: string; numberColor: string; pattern: string };
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
  humanSide: 0 | 1;
  homeManager: string;
  awayManager: string;
  homeFormation: string;
  awayFormation: string;
  homeFormationId: number;
  awayFormationId: number;
  automationDisabled?: [boolean, boolean];
  automationFiredCount?: number;
}

export function liveStateView(world: World, st: LiveMatchState, viewerUserId?: number | null): LiveStateView {
  const byId = new Map(world.players.map((p) => [p.id, p]));
  const club = (id: number) => world.clubs.find((c) => c.id === id);
  const comp = world.competitions.find((c) => c.id === st.competitionId);
  const home = club(st.homeClubId);
  const away = club(st.awayClubId);
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
      overall: p.overall,
      energy: p.energy,
      injuryDays: p.injuryDays,
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
  }));
  // Determine which side the viewer controls (if any).
  const viewerClub = viewerUserId !== undefined && viewerUserId !== null ? world.clubs.find((c) => c.ownerUserId === viewerUserId) : undefined;
  const humanClubId = viewerClub?.id ?? null;
  return {
    matchId: st.matchId,
    fixtureId: st.fixtureId,
    competitionId: st.competitionId,
    competitionName: comp?.name ?? "",
    dateLabel: multiplayerDayLabel(world.dayIndex),
    homeClubId: st.homeClubId,
    awayClubId: st.awayClubId,
    home: home?.name ?? "",
    away: away?.name ?? "",
    // Kit Lab: full home/away designs so pitch markers can mirror the pattern.
    homeKit: (() => {
      const k = home ? resolveClubKits(home).home : null;
      return {
        primary: k?.primary ?? "#23a55a",
        secondary: k?.secondary ?? "#14693c",
        accent: k?.accent ?? "#ffffff",
        numberColor: k?.numberColor ?? "#ffffff",
        pattern: k?.pattern ?? "solid",
      };
    })(),
    awayKit: (() => {
      const k = away ? resolveClubKits(away).away : null;
      return {
        primary: k?.primary ?? "#f0b429",
        secondary: k?.secondary ?? "#8c6510",
        accent: k?.accent ?? "#ffffff",
        numberColor: k?.numberColor ?? "#ffffff",
        pattern: k?.pattern ?? "solid",
      };
    })(),
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
    homeManager: home?.coachName ?? "",
    awayManager: away?.coachName ?? "",
    homeFormation: formationName(home),
    awayFormation: formationName(away),
    homeFormationId: home?.tactics?.formation ?? 4,
    awayFormationId: away?.tactics?.formation ?? 4,
    automationDisabled: st.automationDisabled ?? [false, false],
    automationFiredCount: st.automationFiredRuleIds?.length ?? 0,
  };
}

function formationName(club: { tactics?: { formation: number } } | undefined): string {
  if (!club?.tactics) return "";
  return FORMATION_NAMES[club.tactics.formation] ?? "";
}
