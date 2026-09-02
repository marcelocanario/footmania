import type {
  AutomationPreset,
  Club,
  Competition,
  Fixture,
  LiveMatchState,
  Match,
  World,
} from "./types";
import { createLiveMatchState, applyLiveMatchEnergy, applyMatchToPlayers, buildMatchFromState, tickLiveMatch, isHalftime } from "./match";
import { updateStandings } from "./league";
import { gameConfig, MP_CONFIG } from "../config";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";
import { syncClubSeasons } from "./multiplayer";
import { applyMatchElo } from "./elo";
import { computeMatchRatingRows, mvpFromRatings } from "./matchRatings";
import { EVENT_CODES } from "./constants";
import { processAutomation } from "./automation";
import { applyMatchFamiliarity } from "./familiarity";

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
export function startLiveMatch(world: World, fixture: Fixture, startAt = fixture.kickoffAt ?? Date.now()): Match | null {
  const home = findClub(world, fixture.homeClubId);
  const away = findClub(world, fixture.awayClubId);
  if (!home || !away) return null;
  // AI rotation (plan 9 §21.4): futureCost is zeroed when no further league
  // fixture follows this season for the club.
  const futureFixtures = (clubId: number): boolean =>
    world.fixtures.some((f) => !f.played && f.id !== fixture.id && f.competitionId === fixture.competitionId && (f.homeClubId === clubId || f.awayClubId === clubId));
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
    absoluteGameDay: world.mp.absoluteGameDay ?? world.dayIndex,
    roundsPerSeason: gameConfig.roundsPerSeason,
    matchSpacingDays: gameConfig.matchSpacingDays,
    homeFutureFixtures: futureFixtures(home.id),
    awayFutureFixtures: futureFixtures(away.id),
  });
  world.liveMatches.push(st);
  // A restarted worker must account for time spent offline. Normal scheduled
  // starts use the fixture kickoff as the pacing origin; an administrator can
  // start a fixture early, in which case the explicit start time is the origin
  // so the match does not remain frozen until its original kickoff.
  st.lastAdvancedAt = startAt;
  for (const clubId of [home.id, away.id]) {
    const club = findClub(world, clubId);
    if (club) club.liveMatchAt = startAt;
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
export function advanceLiveMatches(
  world: World,
  now: number,
  opts?: { forceFinish?: boolean; automationPresets?: Map<number, AutomationPreset[]> }
): Match[] {
  const finished: Match[] = [];
  const realMsPerMatchMinute = (MP_CONFIG.matchDurationMinutes * 60 * 1000) / 90;
  // Presets are club-scoped configuration loaded on demand by the caller
  // (services/automationPresetService.ts), never held on the in-memory
  // Club/World for every club (plan §11 Part 4). A caller that doesn't care
  // about automation (tests, aiTakeover's forced completion) simply omits it;
  // automation then safely no-ops for every club.
  const automationPresets = opts?.automationPresets ?? new Map<number, AutomationPreset[]>();
  for (const st of [...world.liveMatches]) {
    if (st.ended) {
      const m = finalizeLiveMatch(world, st);
      if (m) finished.push(m);
      continue;
    }
    const home = findClub(world, st.homeClubId);
    const away = findClub(world, st.awayClubId);
    if (!home || !away) continue;

    // Admin "resolve now": simulate the remainder of the match to full time in
    // one pass, bypassing wall-clock pacing. The engine advances a continuous
    // clock and only discovers stoppage time once it reaches the raw boundary,
    // so loop (bounded) until full time, recomputing the remaining seconds each
    // pass. `ignoreHalfTime` auto-plays through the halftime pause — resolving
    // means completing the match now, not waiting on the wall-clock pause.
    if (opts?.forceFinish && !st.ended) {
      let guard = 0;
      while (!st.ended && guard++ < 250) {
        const totalRegulation = MS.timing.regulationSeconds + (st.firstHalfAddedMinutes ?? 0) * 60 + (st.secondHalfAddedMinutes ?? 0) * 60;
        const remainingSeconds = Math.max(0, totalRegulation - st.matchClockSeconds);
        if (remainingSeconds <= 0) break;
        const beforeLen = st.events.length;
        tickLiveMatch(world.rng, home, away, world.players, st, Math.max(1, Math.ceil(remainingSeconds / 60)), { ignoreHalfTime: true });
        st.lastAdvancedAt = now;
        // This path jumps several match-minutes per iteration (bypassing the
        // normal per-minute pacing), so MINUTE-triggered rules can miss their
        // exact minute — acceptable here: only an admin's forced early
        // completion takes this path, never the ordinary overdue catch-up.
        processAutomation(world, st, st.events.slice(beforeLen), automationPresets);
      }
      if (st.ended) {
        const m = finalizeLiveMatch(world, st);
        if (m) finished.push(m);
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Halftime wall-clock pause (human-involving only, skippable via both-ready)
    // -----------------------------------------------------------------------
    if (isHalftime(st)) {
      const involvesHuman = !!home.ownerUserId || !!away.ownerUserId;
      if (involvesHuman) {
        st.halftimeStartedAt ??= now;
        st.halftimeReady ??= [false, false];
        st.lastAdvancedAt ??= now;
        // Evaluate automation while genuinely paused at half-time: this is
        // the fix for the half-time defect where a HALF_TIME rule (including
        // an automated formation change, §11) could never actually apply
        // because this branch used to `continue` before automation ever ran.
        // Idempotent (fire-count bookkeeping) across the many ticks a real
        // pause can span, so calling it every tick here is safe and cheap
        // once a rule has already applied.
        processAutomation(world, st, [], automationPresets);
        const pauseMs = MP_CONFIG.halftimePauseMinutes * 60 * 1000;
        const homeReady = !home.ownerUserId || !!st.halftimeReady[0];
        const awayReady = !away.ownerUserId || !!st.halftimeReady[1];
        const bothReady = homeReady && awayReady;
        const wallElapsed = now - (st.halftimeStartedAt ?? now) >= pauseMs;
        if (!bothReady && !wallElapsed) {
          // Keep pacing frozen so the 5-min wall interval is not counted as match minutes.
          st.lastAdvancedAt = st.halftimeStartedAt ?? now;
          continue;
        }
        // Resume: both ready or wall time elapsed.
        tickLiveMatch(world.rng, home, away, world.players, st, 1, { resume: true });
        st.lastAdvancedAt = now;
        st.halftimeStartedAt = null;
        st.halftimeReady = [false, false];
        // Second half starts on the next worker tick to keep pacing exact.
        continue;
      }
    }

    const last = st.lastAdvancedAt ?? now;
    const elapsedMs = Math.max(0, now - last);
    const wholeMinutes = Math.floor(elapsedMs / realMsPerMatchMinute);
    if (wholeMinutes <= 0) continue;

    const clockSeconds = typeof st.matchClockSeconds === "number"
      ? st.matchClockSeconds
      : ((st.half === 1 ? st.firstHalfLen : 0) + st.minute) * 60;
    const totalRegulation = MS.timing.regulationSeconds + (st.firstHalfAddedMinutes ?? 0) * 60 + (st.secondHalfAddedMinutes ?? 0) * 60;
    const remainingMinutes = Math.max(0, (totalRegulation - clockSeconds) / 60);
    const minutes = Math.min(wholeMinutes, Math.max(1, Math.ceil(remainingMinutes)));
    // Added time is only stamped once the clock enters stoppage. A downtime
    // catch-up whose minute budget was frozen before that discovery would
    // otherwise strand an overdue match one tick short of full time, so the
    // loop keeps running while newly discovered added time extends the
    // requirement (bounded well above any realistic stoppage total).
    const addedAtEntry = (st.firstHalfAddedMinutes ?? 0) + (st.secondHalfAddedMinutes ?? 0);
    const hardCap = wholeMinutes + 20;
    let iter = 0;
    while (!st.ended && iter < hardCap) {
      if (iter >= minutes) {
        const addedNow = (st.firstHalfAddedMinutes ?? 0) + (st.secondHalfAddedMinutes ?? 0);
        if (addedNow <= addedAtEntry) break;
      }
      iter++;
      // During halftime we already handled the pause above; for normal play we
      // auto-play through the halftime boundary only for AI vs AI (human pause
      // is handled explicitly). Using ignoreHalfTime lets the engine cross the
      // boundary and flip period; the wall-clock gate above decides whether to
      // allow that crossing.
      const atHalftimeNow = isHalftime(st);
      const ignore = atHalftimeNow ? (!home.ownerUserId && !away.ownerUserId) : true;
      const beforeLen = st.events.length;
      tickLiveMatch(world.rng, home, away, world.players, st, 1, { ignoreHalfTime: ignore });
      const newEvents = st.events.slice(beforeLen);
      // Automation is human-only and retry-safe (per-rule fire-count bookkeeping).
      processAutomation(world, st, newEvents, automationPresets);
      // If we just entered halftime via this tick, stamp the wall-clock and pause.
      if (isHalftime(st) && st.halftimeStartedAt == null) {
        st.halftimeStartedAt = Date.now();
        st.lastAdvancedAt = Date.now();
        break;
      }
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
  const comp = fixture ? findCompetition(world, fixture.competitionId) : undefined;
  const tier = comp?.tier ?? 1;
  const seasonId = world.mp.seasonId;
  // Post-final-whistle ratings (plan §16/§18): compute durable rows from the
  // live accumulator, applying the season-frozen calibration. Then the MVP is
  // the highest-rated player on the winning team (user directive).
  const ratingRows = computeMatchRatingRows({
    match,
    seasonId,
    tier,
    calibration: calibrationFor(world, seasonId),
    accum: st.ratingAccum,
    players: world.players,
  });
  world.playerMatchRatings ??= [];
  // Idempotent: replace any prior rows for this match.
  world.playerMatchRatings = [...world.playerMatchRatings.filter((r) => r.matchId !== match.id), ...ratingRows];
  const mvp = mvpFromRatings(ratingRows, match);
  if (mvp && !match.events.some((e) => e.type === EVENT_CODES.MVP)) {
    match.events.push({
      minute: 90,
      half: 2,
      type: EVENT_CODES.MVP,
      subtype: 0,
      clubId: mvp.clubId,
      playerId: mvp.playerId,
      player2Id: null,
      goalType: 0,
    });
  }
  if (mvp) match.mvpPlayerId = mvp.playerId;
  const existing = world.matches.find((m) => m.id === st.matchId);
  match.homeWasHuman = existing?.homeWasHuman ?? home.ownerUserId !== null;
  match.awayWasHuman = existing?.awayWasHuman ?? away.ownerUserId !== null;
  match.eloProcessed = existing?.eloProcessed ?? false;

  if (existing) Object.assign(existing, match, { id: st.matchId });
  else world.matches.push(match);
  if (fixture) fixture.played = true;
  // Live fatigue is kept fractional in the persisted match state because the
  // Player table stores integer energy. Commit it once, at full-time, so a
  // save/reload or a worker tick cannot reset in-match fatigue.
  applyLiveMatchEnergy(st, world.players);
  applyMatchToPlayers(match, world);
  applyMatchElo(world, match);
  // §17 familiarity growth for both sides' current setups. Real competitive
  // fixtures only — finalizeLiveMatch never runs for practice matches (they
  // simulate on cloned worlds), so invariant 15 (no practice farming) holds.
  const matchGameDay = world.mp.absoluteGameDay ?? world.dayIndex;
  applyMatchFamiliarity(home, matchGameDay);
  applyMatchFamiliarity(away, matchGameDay);
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

/** Season-frozen calibration map for ratings (plan §10). */
function calibrationFor(world: World, seasonId: number): Record<string, import("./types").RoleCalibrationEntry> | undefined {
  const cal = (world.roleCalibrations ?? []).filter((c) => c.seasonId === seasonId);
  if (cal.length === 0) return undefined;
  const out: Record<string, import("./types").RoleCalibrationEntry> = {};
  for (const c of cal) out[c.role] = c;
  return out;
}

export function roundLabelFor(competition: Competition, round: number): string {
  return `Round ${round + 1}`;
}
