import { ArrowDown, ArrowUp, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";

export function HistoryStatusBadges({ champion, promoted, relegated }: { champion?: boolean; promoted?: boolean; relegated?: boolean }) {
  const { t } = useTranslation();
  if (!champion && !promoted && !relegated) return null;
  return (
    <span className="history-status-badges">
      {champion && <span className="history-status champion"><Trophy size={12} /> {t("historyStatus.champions")}</span>}
      {promoted && <span className="history-status promoted"><ArrowUp size={12} /> {t("historyStatus.promoted")}</span>}
      {relegated && <span className="history-status relegated"><ArrowDown size={12} /> {t("historyStatus.relegated")}</span>}
    </span>
  );
}
