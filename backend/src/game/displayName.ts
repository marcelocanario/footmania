import type { Player } from "./types";

/**
 * Primary display name for a player. Nickname is visible to everyone when set (pro feature);
 * otherwise falls back to the real name.
 */
export function displayName(player: Pick<Player, "name" | "nickname">): string {
  const nick = (player.nickname ?? "").trim();
  return nick.length > 0 ? nick : player.name;
}

/** Secondary label (real name when nicknamed, empty otherwise) for tooltips. */
export function displayNameSecondary(player: Pick<Player, "name" | "nickname">): string | null {
  const nick = (player.nickname ?? "").trim();
  return nick.length > 0 ? player.name : null;
}
