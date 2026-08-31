import type { Player } from "./types";
import { currentSkillsVersion } from "./skillsVersion";

// Shared id -> Player index for the match pipeline.
//
// buildEngine, qualityCompensation and ratingObserverFor each used to build
// their own `new Map(players.map(...))` over the WHOLE world roster, and
// buildEngine runs once per streamed tick and once per one-minute chunk of an
// instant simulation (up to 120 per match). That made match setup O(world
// players) per chunk while only ~44 ids are ever looked up.
//
// The cache key mirrors match.ts's attribute-centers cache: the array
// reference plus the skills version (bumped whenever a player is pushed onto
// world.players; a reassignment of the array self-invalidates by identity).
// Player objects are mutated in place, so a skill change cannot invalidate the
// id -> object mapping — the version guard is simply conservative.
let cachedPlayers: Player[] | null = null;
let cachedVersion = -1;
let cachedIndex: Map<number, Player> | null = null;

export function playerIndexFor(players: Player[]): Map<number, Player> {
  const version = currentSkillsVersion();
  if (cachedIndex && cachedPlayers === players && cachedVersion === version) return cachedIndex;
  const index = new Map<number, Player>();
  for (const player of players) index.set(player.id, player);
  cachedIndex = index;
  cachedPlayers = players;
  cachedVersion = version;
  return index;
}
