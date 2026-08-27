import type { PlayerView } from "../api/client";

export const POSITION_CLASS = ["pos-GK", "pos-FB", "pos-CB", "pos-MF", "pos-FW"];
export const POSITION_LETTER = ["GK", "FB", "CB", "MF", "FW"];
/** Full position names for tooltips (mouse-over on the abbreviated tags). */
export const POSITION_FULL_NAMES = ["Goalkeeper", "Full-back", "Center-back", "Midfielder", "Forward"];
export const positionTitle = (position: number | undefined): string | undefined =>
  position === undefined ? undefined : POSITION_FULL_NAMES[position];

export function PlayerName({ player, showPosition = true, preferNickname = false, showSuspended = true, showInjury = true, customTooltips = false }: { player: Pick<PlayerView, "name" | "nickname" | "displayName" | "position" | "injuryDays" | "suspended" | "onLoan" | "onLoanOut" | "loanClubName" | "loanFromName">; showPosition?: boolean; preferNickname?: boolean; showSuspended?: boolean; showInjury?: boolean; customTooltips?: boolean }) {
  const nickname = (player as unknown as { nickname?: string | null }).nickname;
  const hasNick = Boolean(nickname);
  const shown = preferNickname && nickname ? `“${nickname}”` : ((player as unknown as { displayName?: string }).displayName ?? player.name);
  const positionTooltip = positionTitle(player.position);
  const nicknameTooltip = preferNickname && hasNick ? player.name : undefined;
  return (
    <span className={`player-name${player.onLoan ? " on-loan-in" : ""}${player.onLoanOut ? " on-loan" : ""}`}>
      {showPosition && <span className={`pos-tag ${POSITION_CLASS[player.position] ?? ""}${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": positionTooltip } : { title: positionTooltip })}>{POSITION_LETTER[player.position] ?? "?"}</span>}
      <span className={`nm${customTooltips && nicknameTooltip ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": nicknameTooltip } : { title: nicknameTooltip })}>{shown}</span>
      {hasNick && !preferNickname && <span className={`flag-chip${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": player.name } : { title: player.name })} style={{ borderColor: "var(--gold-2)", color: "var(--gold-2)" }}>“{nickname}”</span>}
      {player.suspended && showSuspended && <span className="flag-chip fc-sus">SUS</span>}
      {showInjury && player.injuryDays > 0 && <span className="flag-chip fc-inj">INJ {player.injuryDays}d</span>}
      {player.onLoan && <span className={`flag-chip fc-loan${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": `On loan from ${player.loanFromName ?? "another club"}` } : { title: `On loan from ${player.loanFromName ?? "another club"}` })}>LOAN</span>}
      {player.onLoanOut && <span className={`flag-chip fc-loan${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": `On loan at ${player.loanClubName ?? "another club"}` } : { title: `On loan at ${player.loanClubName ?? "another club"}` })}>LOAN</span>}
    </span>
  );
}
