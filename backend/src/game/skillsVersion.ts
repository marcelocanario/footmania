// Monotonic counter bumped whenever a mutation could change the result of
// computeAttributeCenters over world.players: a player's tec/pace/physical
// (des+playmaking)/fin/gol/des skill value, or the population of world.players
// itself (a push; array *reassignment* self-invalidates callers' caches via
// reference identity and does not need a bump). Consumers cache attribute
// centers keyed on this version plus the players-array reference, so a
// missed bump would cause stale centers rather than a crash -- every
// mutation site above must call bumpSkillsVersion().
let version = 0;

export function bumpSkillsVersion(): void {
  version++;
}

export function currentSkillsVersion(): number {
  return version;
}
