import type { Player, World } from "./types";
import { nextInt } from "./rng";

/**
 * Squad numbers. Rules (product spec):
 *  - At roster creation numbers are random, except goalkeepers: the highest
 *    overall GK wears 1 and the second-highest GK wears 12.
 *  - Numbers are unique within a club.
 *  - Managers may reassign numbers; taking a taken number swaps the two players.
 */

export const SQUAD_NUMBER_MIN = 1;
export const SQUAD_NUMBER_MAX = 99;
/** Inclusive pool drawn from when a number is randomized (2..40). */
const RANDOM_POOL_MAX = 40;

/** Assign fresh random numbers to every player in the list (club creation). */
export function assignInitialSquadNumbers(rng: World["rng"], players: Player[]): void {
  const used = new Set<number>();
  const assigned = new Set<number>();
  const gks = players.filter((p) => p.position === "GK").sort((a, b) => b.overall - a.overall);
  // Goalkeeper rule: #1 for the top GK, #12 for the second.
  if (gks[0]) {
    gks[0].squadNumber = 1;
    used.add(1);
    assigned.add(gks[0].id);
  }
  if (gks[1]) {
    gks[1].squadNumber = 12;
    used.add(12);
    assigned.add(gks[1].id);
  }
  for (const p of players) {
    if (assigned.has(p.id)) continue;
    p.squadNumber = drawFreeNumber(rng, used);
    used.add(p.squadNumber!);
  }
}

/**
 * Give every club player without a number a free one, keeping existing
 * assignments stable. Used when a player joins a club via transfer, loan,
 * promotion or intervention replacement.
 */
export function ensureClubSquadNumbers(world: World, clubId: number): void {
  const squad = world.players.filter((p) => p.clubId === clubId);
  const used = new Set<number>(squad.map((p) => p.squadNumber).filter((n): n is number => typeof n === "number"));
  const missing = squad.filter((p) => typeof p.squadNumber !== "number");
  // Prefer the goalkeeper numbers for goalkeepers joining without a number.
  for (const p of missing) {
    if (p.position === "GK" && !used.has(1)) {
      p.squadNumber = 1;
      used.add(1);
      continue;
    }
    p.squadNumber = drawFreeNumber(world.rng, used);
    used.add(p.squadNumber!);
  }
}

/**
 * Manual reassignment by the manager. If another player of the same club
 * already wears the requested number they swap, so the edit never fails on a
 * duplicate. Returns an error message instead of mutating on invalid input.
 */
export function setPlayerSquadNumber(world: World, playerId: number, rawNumber: number): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(rawNumber) || rawNumber < SQUAD_NUMBER_MIN || rawNumber > SQUAD_NUMBER_MAX) {
    return { ok: false, error: `Number must be between ${SQUAD_NUMBER_MIN} and ${SQUAD_NUMBER_MAX}` };
  }
  const player = world.players.find((p) => p.id === playerId);
  if (!player || player.clubId === null) return { ok: false, error: "Player not found" };
  const squadmate = world.players.find((p) => p.clubId === player.clubId && p.squadNumber === rawNumber && p.id !== playerId);
  const previous = player.squadNumber ?? null;
  player.squadNumber = rawNumber;
  if (squadmate) squadmate.squadNumber = previous;
  return { ok: true };
}

function drawFreeNumber(rng: World["rng"], used: Set<number>): number {
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = SQUAD_NUMBER_MIN + 1 + nextInt(rng, RANDOM_POOL_MAX - 1); // 2..RANDOM_POOL_MAX
    if (!used.has(candidate)) return candidate;
  }
  // Pool exhausted (very large squads): fall back to the first free number.
  for (let candidate = SQUAD_NUMBER_MIN + 1; candidate <= SQUAD_NUMBER_MAX; candidate++) {
    if (!used.has(candidate)) return candidate;
  }
  return used.size + 1;
}
