import type { PlayerView } from "../api/client";

export const POSITION_CLASS = ["pos-GK", "pos-FB", "pos-CB", "pos-MF", "pos-FW"];
export const POSITION_LETTER = ["GK", "FB", "CB", "MF", "FW"];

export function PlayerName({ player }: { player: Pick<PlayerView, "name" | "position" | "injuryDays" | "suspended" | "onLoan" | "onLoanOut" | "loanClubName" | "loanFromName"> }) {
  return (
    <span className={`player-name${player.onLoanOut ? " on-loan" : ""}`}>
      <span className={`pos-tag ${POSITION_CLASS[player.position] ?? ""}`}>{POSITION_LETTER[player.position] ?? "?"}</span>
      <span className="nm">{player.name}</span>
      {player.suspended && <span className="flag-chip fc-sus">SUS</span>}
      {player.injuryDays > 0 && <span className="flag-chip fc-inj">INJ {player.injuryDays}d</span>}
      {player.onLoan && <span className="flag-chip fc-loan" title={`On loan from ${player.loanFromName ?? "another club"}`}>LOAN</span>}
      {player.onLoanOut && <span className="flag-chip fc-loan" title={`On loan at ${player.loanClubName ?? "another club"}`}>LOAN</span>}
    </span>
  );
}
