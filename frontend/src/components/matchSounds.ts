import type { LiveEvent } from "../api/client";

// Match-event sound playback for the live match viewer.
//
// Presentation only: nothing here influences the match engine. Event codes and
// subtypes mirror backend EVENT_CODES / GOAL_SUBTYPES (backend/src/game/constants.ts).
const EVENT_GOAL = 1;
const EVENT_RED = 3;
const EVENT_YELLOW_RED = 4;
const EVENT_INJURY = 5;
const EVENT_MISSED_PENALTY = 7;
const EVENT_HALF_TIME = 10;
const EVENT_FULL_TIME = 12;

// Shootout kicks are the only events emitted with this subtype (regulation
// penalties are recorded with NORMAL goalType and are indistinguishable from
// open-play goals — see match.ts career-total filtering).
const GOAL_SUBTYPE_PENALTY = 3;

const SOUND_FILES = {
  goalHome: "/sounds/goal-home.wav",
  goalAway: "/sounds/goal-away.wav",
  redCard: "/sounds/red-card.wav",
  injury: "/sounds/injury.wav",
  halfTime: "/sounds/half-time.wav",
  fullTime: "/sounds/full-time.wav",
  penaltyKick: "/sounds/penalty-kick.wav",
} as const;

/** Whistle → outcome call spacing, mirroring the classic penalty sequence. */
const PENALTY_OUTCOME_GAP_MS = 1000;
/** Upper bound a clip may hold the queue before advancing without "ended". */
const MAX_CLIP_SLOT_MS = 3000;
/** Mirrors CUE_MAX_AGE_MINUTES in MatchPitch: older arrivals are reconnect
 * catch-up, not live moments, and must not blast history at the viewer. */
const FRESH_WINDOW_MINUTES = 3;

interface QueuedSound {
  url: string;
  gapMsAfter: number;
}

const audioCache = new Map<string, HTMLAudioElement>();
let queue: QueuedSound[] = [];
let draining = false;
let muted = false;
let currentClip: HTMLAudioElement | null = null;

function getAudio(url: string): HTMLAudioElement {
  let audio = audioCache.get(url);
  if (!audio) {
    audio = new Audio(url);
    audio.preload = "auto";
    audioCache.set(url, audio);
  }
  return audio;
}

export function preloadMatchSounds(): void {
  Object.values(SOUND_FILES).forEach(getAudio);
}

export function setSoundsMuted(value: boolean): void {
  muted = value;
  if (value) queue = [];
}

/** Stops pending playback entirely (viewer unmounted). */
export function stopMatchSounds(): void {
  queue = [];
  draining = false;
  currentClip?.pause();
  currentClip = null;
}

function playNext(): void {
  currentClip = null;
  if (muted || queue.length === 0) {
    draining = false;
    return;
  }
  const item = queue.shift()!;
  // Clone so repeated plays of the same file don't fight over one element.
  const clip = getAudio(item.url).cloneNode(true) as HTMLAudioElement;
  currentClip = clip;
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    window.setTimeout(playNext, item.gapMsAfter);
  };
  const slotTimer = window.setTimeout(advance, MAX_CLIP_SLOT_MS);
  clip.addEventListener("ended", () => {
    window.clearTimeout(slotTimer);
    advance();
  });
  // Autoplay-policy or decode failures must not stall the queue.
  void clip.play().catch(() => {
    window.clearTimeout(slotTimer);
    advance();
  });
}

function itemsForEvent(event: LiveEvent, homeClubId: number): QueuedSound[] | null {
  switch (event.type) {
    case EVENT_GOAL: {
      const callUrl = event.clubId === homeClubId ? SOUND_FILES.goalHome : SOUND_FILES.goalAway;
      // Shootout kick: whistle first, then the outcome call.
      if (event.subtype === GOAL_SUBTYPE_PENALTY) {
        return [
          { url: SOUND_FILES.penaltyKick, gapMsAfter: PENALTY_OUTCOME_GAP_MS },
          { url: callUrl, gapMsAfter: 0 },
        ];
      }
      return [{ url: callUrl, gapMsAfter: 0 }];
    }
    case EVENT_MISSED_PENALTY: {
      // All MISSED_PENALTY events are shootout kicks; the benefiting side's
      // crowd reacts (home taker misses → away call, away taker misses → home call).
      const missCallUrl = event.clubId === homeClubId ? SOUND_FILES.goalAway : SOUND_FILES.goalHome;
      return [
        { url: SOUND_FILES.penaltyKick, gapMsAfter: PENALTY_OUTCOME_GAP_MS },
        { url: missCallUrl, gapMsAfter: 0 },
      ];
    }
    case EVENT_RED:
    case EVENT_YELLOW_RED:
      return [{ url: SOUND_FILES.redCard, gapMsAfter: 0 }];
    case EVENT_INJURY:
      return [{ url: SOUND_FILES.injury, gapMsAfter: 0 }];
    case EVENT_HALF_TIME:
      return [{ url: SOUND_FILES.halfTime, gapMsAfter: 0 }];
    case EVENT_FULL_TIME:
      return [{ url: SOUND_FILES.fullTime, gapMsAfter: 0 }];
    default:
      return null;
  }
}

export interface MatchSoundBatch {
  events: LiveEvent[];
  homeClubId: number;
  /** Display minute used by the freshness gate. */
  displayMinute: number;
  /** Shootout batches share minute ≈120 and arrive legitimately in one burst,
   * so the freshness gate is bypassed while that phase is running. */
  phase: string;
}

export function enqueueMatchEventSounds(batch: MatchSoundBatch): void {
  if (muted) return;
  const gateFreshness = batch.phase !== "shootout";
  for (const event of batch.events) {
    if (
      gateFreshness &&
      Math.floor(batch.displayMinute) - event.minute > FRESH_WINDOW_MINUTES
    ) {
      continue;
    }
    const items = itemsForEvent(event, batch.homeClubId);
    if (items) queue.push(...items);
  }
  if (queue.length > 0 && !draining) {
    draining = true;
    playNext();
  }
}
