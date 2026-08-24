import { ArrowDown, ArrowUp, Trophy } from "lucide-react";

export function HistoryStatusBadges({ champion, promoted, relegated }: { champion?: boolean; promoted?: boolean; relegated?: boolean }) {
  if (!champion && !promoted && !relegated) return null;
  return (
    <span className="history-status-badges">
      {champion && <span className="history-status champion"><Trophy size={12} /> Champions</span>}
      {promoted && <span className="history-status promoted"><ArrowUp size={12} /> Promoted</span>}
      {relegated && <span className="history-status relegated"><ArrowDown size={12} /> Relegated</span>}
    </span>
  );
}
