import type { PlayerView } from "../api/client";

export const POSITION_CLASS = ["pos-GK", "pos-FB", "pos-CB", "pos-MF", "pos-FW"];
export const POSITION_LETTER = ["GK", "FB", "CB", "MF", "FW"];

export function PlayerName({ player, showPosition = true }: { player: Pick<PlayerView, "name" | "nickname" | "displayName" | "position" | "injuryDays" | "suspended" | "onLoan" | "onLoanOut" | "loanClubName" | "loanFromName">; showPosition?: boolean }) {
  const shown = (player as unknown as { displayName?: string }).displayName ?? player.name;
  const hasNick = Boolean((player as unknown as { nickname?: string | null }).nickname);
  return (
    <span className={`player-name${player.onLoanOut ? " on-loan" : ""}`}>
      {showPosition && <span className={`pos-tag ${POSITION_CLASS[player.position] ?? ""}`}>{POSITION_LETTER[player.position] ?? "?"}</span>}
      <span className="nm">{shown}</span>
      {hasNick && <span className="flag-chip" title={(player as unknown as { name: string }).name} style={{ borderColor: "var(--gold-2)", color: "var(--gold-2)" }}>“{(player as unknown as { nickname: string }).nickname}”</span>}
      {player.suspended && <span className="flag-chip fc-sus">SUS</span>}
      {player.injuryDays > 0 && <span className="flag-chip fc-inj">INJ {player.injuryDays}d</span>}
      {player.onLoan && <span className="flag-chip fc-loan" title={`On loan from ${player.loanFromName ?? "another club"}`}>LOAN</span>}
      {player.onLoanOut && <span className="flag-chip fc-loan" title={`On loan at ${player.loanClubName ?? "another club"}`}>LOAN</span>}
    </span>
  );
}
