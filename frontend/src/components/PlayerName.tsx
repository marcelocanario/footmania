import type { PlayerView } from "../api/client";
import { useTranslation } from "react-i18next";
import { positionClass, positionLabel, positionLetter } from "../positions";

export function PlayerName({ player, showPosition = true, preferNickname = false, showSuspended = true, showInjury = true, customTooltips = false }: { player: Pick<PlayerView, "name" | "nickname" | "displayName" | "naturalPosition" | "injuryDays" | "suspended" | "onLoan" | "onLoanOut" | "loanClubName" | "loanFromName">; showPosition?: boolean; preferNickname?: boolean; showSuspended?: boolean; showInjury?: boolean; customTooltips?: boolean }) {
  const { t } = useTranslation();
  const nickname = (player as unknown as { nickname?: string | null }).nickname;
  const hasNick = Boolean(nickname);
  const shown = preferNickname && nickname ? `“${nickname}”` : ((player as unknown as { displayName?: string }).displayName ?? player.name);
  const positionTooltip = positionLabel(player.naturalPosition);
  const nicknameTooltip = preferNickname && hasNick ? player.name : undefined;
  const tagClass = positionClass(player.naturalPosition);
  const tagLetter = positionLetter(player.naturalPosition);
  return (
    <span className={`player-name${player.onLoan ? " on-loan-in" : ""}${player.onLoanOut ? " on-loan" : ""}`}>
      {showPosition && <span className={`pos-tag ${tagClass}${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": positionTooltip } : { title: positionTooltip })}>{tagLetter}</span>}
      <span className={`nm${customTooltips && nicknameTooltip ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": nicknameTooltip } : { title: nicknameTooltip })}>{shown}</span>
      {hasNick && !preferNickname && <span className={`flag-chip${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": player.name } : { title: player.name })} style={{ borderColor: "var(--gold-2)", color: "var(--gold-2)" }}>“{nickname}”</span>}
      {player.suspended && showSuspended && <span className="flag-chip fc-sus">{t("playerName.sus")}</span>}
      {showInjury && player.injuryDays > 0 && <span className="flag-chip fc-inj">{t("playerName.inj", { days: player.injuryDays })}</span>}
      {player.onLoan && <span className={`flag-chip fc-loan${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": t("playerName.loanFromTip", { club: player.loanFromName ?? t("playerName.anotherClub") }) } : { title: t("playerName.loanFromTip", { club: player.loanFromName ?? t("playerName.anotherClub") }) })}>{t("playerName.loan")}</span>}
      {player.onLoanOut && <span className={`flag-chip fc-loan${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": t("playerName.loanAtTip", { club: player.loanClubName ?? t("playerName.anotherClub") }) } : { title: t("playerName.loanAtTip", { club: player.loanClubName ?? t("playerName.anotherClub") }) })}>{t("playerName.loan")}</span>}
    </span>
  );
}
