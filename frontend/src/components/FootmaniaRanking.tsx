import { Medal, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FootmaniaRankingEntry } from "../api/client";
import { countryFlag } from "../countryFlags";
import { ClubCrest } from "./ClubCrest";
import { ClubNameLink } from "./ClubNameLink";

export function FootmaniaRankBadge({ rank, compact = false }: { rank: number | null; compact?: boolean }) {
  const { t } = useTranslation();
  if (rank === null) return <span className={`footmania-rank-badge muted${compact ? " compact" : ""}`}>{t("ranking.notRanked")}</span>;
  const tier = rank <= 3 ? "podium" : rank <= 10 ? "top-ten" : "standard";
  return (
    <span className={`footmania-rank-badge ${tier}${compact ? " compact" : ""}`}>
      <Trophy size={compact ? 12 : 14} />
      {t("ranking.fmRank", { rank })}
    </span>
  );
}

function RankingRow({ entry }: { entry: FootmaniaRankingEntry }) {
  const flag = countryFlag(entry.country);
  return (
    <div className={`footmania-ranking-row${entry.rank <= 3 ? " podium" : ""}`}>
      <span className={`footmania-ranking-place${entry.rank <= 3 ? " podium" : ""}`}>{entry.rank}</span>
      <ClubCrest
        name={entry.name}
        primary={entry.primaryColor}
        secondary={entry.secondaryColor}
        kit={entry.kit}
        size={34}
        clubId={entry.clubId}
        hasCustomLogo={entry.hasCustomLogo}
      />
      <div className="footmania-ranking-club">
        <ClubNameLink clubId={entry.clubId} name={entry.name} showCrest={false} />
        <span>{flag ? `${flag} ` : ""}{entry.country}</span>
      </div>
      {entry.rank <= 3 && <Medal size={16} className="footmania-ranking-medal" />}
    </div>
  );
}

export function FootmaniaRankingPanel({
  rankings,
  totalRanked,
  viewerRank,
}: {
  rankings: FootmaniaRankingEntry[];
  totalRanked: number;
  viewerRank: number | null;
}) {
  const { t } = useTranslation();
  return (
    <section className="card footmania-ranking-panel">
      <div className="footmania-ranking-head">
        <div>
          <div className="kicker">{t("ranking.worldRanking")}</div>
          <h2><Trophy size={18} /> {t("ranking.ranking")}</h2>
        </div>
        <span className="footmania-ranking-count">{t("ranking.activeClubs", { count: totalRanked })}</span>
      </div>
      <p className="footmania-ranking-copy">{t("ranking.copy")}</p>
      {rankings.length === 0 ? (
        <div className="empty-state" style={{ padding: "28px 10px" }}>{t("ranking.empty")}</div>
      ) : (
        <div className="footmania-ranking-list">
          {rankings.map((entry) => <RankingRow key={entry.clubId} entry={entry} />)}
        </div>
      )}
      {viewerRank !== null && (
        <div className="footmania-ranking-footer">
          <span>{t("ranking.yourRank")}</span>
          <FootmaniaRankBadge rank={viewerRank} compact />
        </div>
      )}
    </section>
  );
}
