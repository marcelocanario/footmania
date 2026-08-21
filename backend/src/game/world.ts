import type {
  Club,
  Competition,
  Fixture,
  LiveMatchState,
  Match,
  World,
} from "./types";
import { createLiveMatchState, applyLiveMatchEnergy, applyMatchToPlayers, buildMatchFromState, tickLiveMatch } from "./match";
import { updateStandings } from "./league";
import { MP_CONFIG } from "../config";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";
import { syncClubSeasons } from "./multiplayer";
import { applyMatchElo } from "./elo";
import { processAutomation } from "./automation";

function emptyTeamStats() {
  return {
    controlledBallSeconds: 0,
    attackingThirdControlledSeconds: 0,
    possessions: 0,
    passes: 0,
    crosses: 0,
    carries: 0,
    dribbles: 0,
    turnovers: 0,
    highRecoveries: 0,
    counterattacks: 0,
    counterattackShots: 0,
    boxEntries: 0,
    shots: 0,
    shotsOnTarget: 0,
    xG: 0,
    corners: 0,
    fouls: 0,
    yellows: 0,
    reds: 0,
    offsides: 0,
    penalties: 0,
    injuries: 0,
  };
}

export function findClub(world: World, id: number): Club | undefined {
  return world.clubs.find((c) => c.id === id);
}

export function findCompetition(world: World, id: number): Competition | undefined {
  return world.competitions.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Multiplayer worker core (server-authoritative)
// ---------------------------------------------------------------------------

/** Create a live match state for a scheduled fixture. Every league match fires
 *  live at its kickoff, whether or not a human is watching; humans present can
 *  intervene via the WebSocket (subs, formation). */
export function startLiveMatch(world: World, fixture: Fixture): Match | null {
  const home = findClub(world, fixture.homeClubId);
  const away = findClub(world, fixture.awayClubId);
  if (!home || !away) return null;
  const comp = findCompetition(world, fixture.competitionId);
  const match: Match = {
    id: world.nextId++,
    fixtureId: fixture.id,
    competitionId: fixture.competitionId,
    homeClubId: fixture.homeClubId,
    awayClubId: fixture.awayClubId,
    homeScore: 0,
    awayScore: 0,
    penaltyWinnerId: null,
    events: [],
    stats: { home: emptyTeamStats(), away: emptyTeamStats() },
    minuteEvents: [],
    homeWasHuman: home.ownerUserId !== null,
    awayWasHuman: away.ownerUserId !== null,
    eloProcessed: false,
  };
  world.matches.push(match);
  const st = createLiveMatchState(world.rng, home, away, world.players, {
    matchId: match.id,
    competitionId: fixture.competitionId,
    fixtureId: fixture.id,
    homeNeutral: false,
    decider: false,
    compKind: comp?.kind ?? "division",
    year: world.mp.seasonYear,
  });
  world.liveMatches.push(st);
  // A restarted worker must account for time spent offline. The fixture's
  // scheduled kickoff, rather than process start time, is the pacing origin.
  st.lastAdvancedAt = fixture.kickoffAt ?? Date.now();
  for (const clubId of [home.id, away.id]) {
    const club = findClub(world, clubId);
    if (club) club.liveMatchAt = fixture.kickoffAt ?? Date.now();
  }
  return match;
}

/**
 * Advance in-progress live matches based on real elapsed time (plan §37/§54).
 *
 * The configured `matchDurationMinutes` is the real-world wall-clock time a
 * full match (90 match minutes) takes to play out. Each call computes how many
 * match minutes are due since the match's `lastAdvancedAt`, carrying the
 * fractional remainder so cumulative pacing stays exact regardless of tick
 * rate or downtime. Auto-plays through halftime (`resume: true`) so matches
 * finish on schedule for unattended clubs.
 */
export function advanceLiveMatches(world: World, now: number): Match[] {
  const finished: Match[] = [];
  const realMsPerMatchMinute = (MP_CONFIG.matchDurationMinutes * 60 * 1000) / 90;
  for (const st of [...world.liveMatches]) {
    if (st.ended) {
      const m = finalizeLiveMatch(world, st);
      if (m) finished.push(m);
      continue;
    }
    const home = findClub(world, st.homeClubId);
    const away = findClub(world, st.awayClubId);
    if (!home || !away) continue;
    const last = st.lastAdvancedAt ?? now;
    const elapsedMs = Math.max(0, now - last);
    const wholeMinutes = Math.floor(elapsedMs / realMsPerMatchMinute);
    if (wholeMinutes <= 0) continue;

    const clockSeconds = typeof st.matchClockSeconds === "number"
      ? st.matchClockSeconds
      : ((st.half === 1 ? st.firstHalfLen : 0) + st.minute) * 60;
    const remainingMinutes = Math.max(0, (MS.timing.regulationSeconds - clockSeconds) / 60);
    const minutes = Math.min(wholeMinutes, Math.max(1, Math.ceil(remainingMinutes)));
    // Advance one match-minute at a time so per-minute automation triggers fire correctly
    // even when catching up after downtime (otherwise a 10-minute catch-up would skip 9 minutes of rules).
    for (let iter = 0; iter < minutes; iter++) {
      if (st.ended) break;
      const beforeLen = st.events.length;
      tickLiveMatch(world.rng, home, away, world.players, st, 1, { ignoreHalfTime: true });
      const newEvents = st.events.slice(beforeLen);
      // Automation is human-only and retry-safe via st.automationFiredRuleIds.
      processAutomation(world, st, newEvents);
    }
    // The match is now fully simulated up to the real time that `minutes`
    // match-minutes represent. Any sub-minute fraction of the elapsed window
    // is preserved for the next tick (lastAdvancedAt only moves forward by the
    // real time consumed, so a 5s worker still finishes in ~matchDuration).
    st.lastAdvancedAt = last + minutes * realMsPerMatchMinute;
    if (st.ended) {
      const m = finalizeLiveMatch(world, st);
      if (m) finished.push(m);
    }
  }
  return finished;
}

/** Finalize a finished live match: apply standings and player effects. */
export function finalizeLiveMatch(world: World, st: LiveMatchState): Match | null {
  const home = findClub(world, st.homeClubId);
  const away = findClub(world, st.awayClubId);
  const fixture = world.fixtures.find((f) => f.id === st.fixtureId);
  if (!home || !away) return null;
  const live = world.liveMatches.find((x) => x.matchId === st.matchId);
  const match = live ? buildMatchFromState(live, home, away, world.players) : null;
  if (!match) return null;
  const existing = world.matches.find((m) => m.id === st.matchId);
  match.homeWasHuman = existing?.homeWasHuman ?? home.ownerUserId !== null;
  match.awayWasHuman = existing?.awayWasHuman ?? away.ownerUserId !== null;
  match.eloProcessed = existing?.eloProcessed ?? false;
  const comp = fixture ? findCompetition(world, fixture.competitionId) : undefined;

  if (existing) Object.assign(existing, match, { id: st.matchId });
  else world.matches.push(match);
  if (fixture) fixture.played = true;
  // Live fatigue is kept fractional in the persisted match state because the
  // Player table stores integer energy. Commit it once, at full-time, so a
  // save/reload or a worker tick cannot reset in-match fatigue.
  applyLiveMatchEnergy(st, world.players);
  applyMatchToPlayers(match, world);
  applyMatchElo(world, match);
  if (existing) existing.eloProcessed = match.eloProcessed;
  for (const id of st.suspensionClears ?? []) {
    const p = world.players.find((x) => x.id === id);
    if (p) p.suspendedGames = Math.max(0, p.suspendedGames - 1);
  }
  if (fixture && comp && comp.kind === "division") {
    updateStandings(comp, fixture.homeClubId, fixture.awayClubId, match.homeScore, match.awayScore);
    if (comp.seasonId !== undefined) syncClubSeasons(world, comp.seasonId);
  }
  // Remove the finished live state.
  world.liveMatches = world.liveMatches.filter((x) => x.matchId !== st.matchId);
  for (const club of [home, away]) club.liveMatchAt = null;
  return match;
}

export function roundLabelFor(competition: Competition, round: number): string {
  return `Round ${round + 1}`;
}
