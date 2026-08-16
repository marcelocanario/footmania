import type { PlayerView } from "../api/client";

export const POSITION_CLASS = ["pos-GK", "pos-FB", "pos-CB", "pos-MF", "pos-FW"];
export const POSITION_LETTER = ["GK", "FB", "CB", "MF", "FW"];

export function PlayerName({ player }: { player: Pick<PlayerView, "name" | "position" | "isStar" | "worldClass" | "injuryDays" | "suspended"> }) {
  return (
    <span className="player-name">
      <span className={`pos-tag ${POSITION_CLASS[player.position] ?? ""}`}>{POSITION_LETTER[player.position] ?? "?"}</span>
      <span className="nm">{player.name}</span>
      {player.worldClass && <span className="flag-chip fc-wc">WC</span>}
      {player.isStar && <span className="flag-chip fc-star">★</span>}
      {player.suspended && <span className="flag-chip fc-sus">SUS</span>}
      {player.injuryDays > 0 && <span className="flag-chip fc-inj">INJ {player.injuryDays}d</span>}
    </span>
  );
}
