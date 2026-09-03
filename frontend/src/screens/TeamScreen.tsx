import { useCallback, useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarDays, Clock, History as HistoryIcon, Landmark, LayoutGrid, Pencil, Shirt, Trophy, UserRound, Users } from "lucide-react";
import { api, type FixtureView, type TeamProfile } from "../api/client";
import { countryFlag } from "../countryFlags";
import { money } from "../format";
import { positionLabel } from "../positions";
import { useGame } from "../store/game";
import { groupLabel } from "../components/competition/shared";
import { ClubCrest } from "../components/ClubCrest";
import { FootballKit } from "../components/kit/FootballKit";
import { PlayerDetailsDialog } from "../components/PlayerDetailsDialog";
import { StandingsTable } from "../components/competition/StandingsTable";
import { MatchResultDialog } from "../components/competition/MatchResultDialog";
import { ClubNameLink } from "../components/ClubNameLink";
import { FootmaniaRankBadge } from "../components/FootmaniaRanking";
import { SeasonHistoryTimeline } from "../components/SeasonHistoryTimeline";

/**
 * Public team screen (/team/:id): identity hero, kits, current division
 * table, results & fixtures and the immutable season timeline. Every club
 * name across the app links here.
 */
export function TeamScreen() {
  const { t } = useTranslation();
  const { clubId } = useParams();
  const navigate = useNavigate();
  const statusClubId = useGame((s) => s.status?.userClubId ?? null);
  const [profile, setProfile] = useState<TeamProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Finished-match popout (events history), same as the Competitions screen.
  const [resultFixture, setResultFixture] = useState<FixtureView | null>(null);
  // Player info popout, reused from Squad/MatchHistory.
  const [playerTarget, setPlayerTarget] = useState<{ id: number; name: string } | null>(null);

  const id = Number(clubId);
  const load = useCallback(() => {
    if (!Number.isInteger(id) || id <= 0) {
      setError(t("team.unknown"));
      return;
    }
    setError(null);
    return api.teamProfile(id).then(setProfile).catch((e) => setError((e as Error).message));
  }, [id]);

  useEffect(() => {
    setProfile(null);
    void load();
    return api.cache.subscribe((scope) => {
      if (scope === "mp" || scope === "background:mp") void load();
    });
  }, [load]);

  if (error) return <div className="empty-state" style={{ paddingTop: 80 }}>{error}</div>;
  if (!profile) return <div className="empty-state" style={{ paddingTop: 80 }}>{t("team.loading")}</div>;

  const { club } = profile;
  const flag = countryFlag(club.country);
  const isOwnClub = club.id === statusClubId;
  const played = profile.fixtures.filter((f) => f.played && f.matchId != null);
  const upcoming = profile.fixtures.filter((f) => !f.played);
  const seasonComplete = profile.fixtures.length > 0 && profile.fixtures.every((f) => f.played);
  const titlesTotal = Object.values(profile.trophies).reduce((sum, count) => sum + count, 0);

  return (
    <div>
      {/* Hero banner tinted with the club's own colours */}
      <div
        className="team-hero"
        style={{ ["--hero-a" as string]: club.primaryColor, ["--hero-b" as string]: club.secondaryColor }}
      >
        <div className="floodlights" />
        <div className="team-hero-row">
          <ClubCrest name={club.name} primary={club.primaryColor} secondary={club.secondaryColor} kit={club.kits?.home ?? null} size={78} clubId={club.id} hasCustomLogo={club.hasCustomLogo} />
          <div className="team-hero-id">
            <h1>{club.name}</h1>
            <div className="team-hero-meta">
              <span>{flag ? `${flag} ` : ""}{club.country}</span>
              <span className="meta-sep">·</span>
              <span><Landmark size={13} /> {club.stadiumName}</span>
              <span className="meta-sep">·</span>
              <span><UserRound size={13} /> {club.coachName}</span>
            </div>
            <div className="head-chips">
              {isOwnClub && (
                <span className="chip" style={{ borderColor: "rgba(240,180,41,0.65)", color: "var(--gold-2)", background: "rgba(240,180,41,0.14)" }}>
                  {t("team.yourClub")}
                </span>
              )}
              <span className={`chip${club.isHuman ? "" : " muted"}`}>{club.isHuman ? t("team.humanManaged") : t("team.aiClub")}</span>
              {club.competitionState === "PROVISIONAL" && (
                <span className="chip" style={{ borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)" }}>{t("team.joinsNextSeason")}</span>
              )}
              {club.competitionState === "DORMANT" && (
                <span className="chip" style={{ borderColor: "rgba(120,140,130,0.45)", color: "var(--text-3)" }}>{t("team.dormant")}</span>
              )}
            </div>
          </div>
          <div className="team-hero-titles" title={t("team.divisionTitles")}>
            <Trophy size={20} />
            <b>{titlesTotal}</b>
          </div>
          <div className="team-hero-ranking">
            <FootmaniaRankBadge rank={profile.footmaniaRank} compact />
            <span>{t("team.footmaniaRank")}</span>
          </div>
        </div>
        {isOwnClub && (
          <button className="btn ghost team-hero-edit" onClick={() => navigate("/my-club")}>
            <Pencil size={13} /> {t("team.editMyClub")}
          </button>
        )}
      </div>

      {/* Overview | History tabs: history lives at /history/:id in the world-archive layout. */}
      <div className="segmented team-tabs" role="tablist" aria-label={t("team.profileSections")} style={{ marginTop: 16 }}>
        <NavLink to={`/team/${club.id}`} end role="tab" className={({ isActive }) => (isActive ? "active" : "")}>
          <LayoutGrid size={14} /> {t("team.overviewTab")}
        </NavLink>
        <NavLink to={`/history/${club.id}`} role="tab" className={({ isActive }) => (isActive ? "active" : "")}>
          <HistoryIcon size={14} /> {t("team.historyTab")}
        </NavLink>
      </div>

      <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
        {/* Kits: all three designs stacked in one card */}
        <div className="card team-kit-card">
          <h2 className="card-title"><Shirt size={17} /> {t("team.kits")}</h2>
          {(["home", "away", "gk"] as const).map((side) => {
            const design = club.kits?.[side];
            if (!design) return null;
            return (
              <div key={side} className="team-kit-item">
                <FootballKit {...design} size={150} />
                <span className="team-kit-label">{side === "gk" ? t("team.gk") : t(side === "home" ? "matchday.home" : "matchday.away")}</span>
              </div>
            );
          })}
        </div>

        {/* Current season snapshot */}
        <div className="card">
          <h2 className="card-title">
            <CalendarDays size={17} />
            {profile.season
              ? t("team.seasonTitle", { tier: profile.season.division.tier, group: groupLabel(profile.season.division.groupIndex), season: profile.season.seasonNumber ?? "?" })
              : t("team.season")}
          </h2>
          {profile.season ? (
            <>
              <div className="stats-row">
                <div className="stat">
                  <div className="label">{t("team.position")}</div>
                  <div className="value" style={{ fontSize: "1.7rem", color: profile.season.position === 1 ? "var(--gold-2)" : undefined }}>
                    {profile.season.position != null ? `#${profile.season.position}` : "—"}
                  </div>
                </div>
                <div className="stat">
                  <div className="label">{t("team.record")}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{profile.season.wins}-{profile.season.draws}-{profile.season.losses}</div>
                </div>
                <div className="stat">
                  <div className="label">{t("team.goals")}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{profile.season.goalsFor}:{profile.season.goalsAgainst}</div>
                </div>
                <div className="stat">
                  <div className="label">{t("team.totalValue")}</div>
                  <div className="value" style={{ fontSize: "1.05rem" }} title={t("team.totalValueTitle")}>{money(profile.totalValue)}</div>
                </div>
              </div>
              <div className="jm-hint" style={{ marginBottom: 8 }}>{t("team.clickClubHint")}</div>
              <StandingsTable
                rows={profile.standings}
                isTopDivision={profile.season.division.tier === 1}
                seasonComplete={seasonComplete}
                onClubClick={(row) => navigate(`/team/${row.clubId}`)}
                compact
                highlightClubId={club.id}
              />
            </>
          ) : (
            <div className="empty-state" style={{ padding: "30px 10px" }}>
              {t("team.notInSeason")}
              {club.competitionState === "PROVISIONAL" && t("team.joinsNextSeasonHint")}
            </div>
          )}
        </div>
      </div>

      {/* Recent results & upcoming matches */}
      {(played.length > 0 || upcoming.length > 0) && (
        <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
          {played.length > 0 && (
            <div className="card">
              <h2 className="card-title"><Clock size={17} /> {t("team.recentResults")}</h2>
              {played.slice(-6).reverse().map((f) => (
                <TeamFixtureRow key={f.id} fixture={f} onOpenResult={() => setResultFixture(f)} />
              ))}
            </div>
          )}
          {upcoming.length > 0 && (
            <div className="card">
              <h2 className="card-title"><CalendarDays size={17} /> {t("team.upcomingMatches")}</h2>
              {upcoming.slice(0, 6).map((f) => (
                <TeamFixtureRow key={f.id} fixture={f} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Simple squad list with the shared player-info popout */}
      {profile.players.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="card-title"><Users size={17} /> {t("squad.title")}</h2>
          <div className="team-player-grid">
            {profile.players.map((p) => {
              const playerFlag = countryFlag(p.country);
              return (
                <button key={p.id} type="button" className={`team-player-row${p.onLoan ? " team-player-loan-in" : ""}`} onClick={() => setPlayerTarget({ id: p.id, name: p.name })}>
                  <span className="rank-pill" title={positionLabel(p.naturalPosition)}>{p.naturalPosition}</span>
                  <b className={p.onLoan ? "loan-in-name" : undefined}>{p.name}{p.nickname ? <> "{p.nickname}"</> : null}</b>
                  {p.isYouth && <span className="chip" style={{ fontSize: "0.62rem", padding: "1px 6px" }}>YTH</span>}
                  {p.onLoan && <span className="flag-chip fc-loan" title={t("team.onLoanFrom", { club: p.loanFromName ?? t("squad.anotherClub") })}>LOAN</span>}
                  <span style={{ marginLeft: "auto", color: "var(--text-3)", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                    {playerFlag ? `${playerFlag} ` : ""}{p.age} yrs
                  </span>
                  <strong style={{ fontFamily: "var(--font-display)", minWidth: 26, textAlign: "right" }}>{p.overall}</strong>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Club journey summary: the full world-archive view lives on the History tab. */}
      <div className="card team-history-card" style={{ marginTop: 16 }}>
        <div className="card-title"><Trophy size={17} /> {t("team.clubJourney")}</div>
        <SeasonHistoryTimeline rows={profile.history} trophies={profile.trophies} />
        <button className="btn ghost" style={{ marginTop: 12 }} onClick={() => navigate(`/history/${club.id}`)}>
          <HistoryIcon size={14} /> {t("team.viewFullHistory")}
        </button>
      </div>

      <MatchResultDialog fixture={resultFixture} onClose={() => setResultFixture(null)} />
      <PlayerDetailsDialog target={playerTarget} onClose={() => setPlayerTarget(null)} />
    </div>
  );
}

/** Compact fixture row for the team screen lists. Played results open the
 *  events popout; live matches jump straight into the stadium. */
function TeamFixtureRow({ fixture, onOpenResult }: { fixture: FixtureView; onOpenResult?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isLive = fixture.liveMatchId != null;
  const clickable = isLive || Boolean(onOpenResult);
  return (
    <div
      className={`result-card${fixture.isHuman ? " human" : ""}${isLive ? " live-now" : ""}`}
      style={{ marginBottom: 6, ...(clickable ? { cursor: "pointer" } : {}) }}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={() => {
        if (isLive && fixture.liveMatchId != null) navigate(`/live-match/${fixture.liveMatchId}`);
        else onOpenResult?.();
      }}
      onKeyDown={(e) => {
        if (!clickable || e.key !== "Enter") return;
        if (isLive && fixture.liveMatchId != null) navigate(`/live-match/${fixture.liveMatchId}`);
        else onOpenResult?.();
      }}
    >
      <span className="chip" style={{ minWidth: 56, justifyContent: "center" }}>{t("team.round", { round: fixture.round + 1 })}</span>
      {isLive && (
        <span className="live-tag" style={{ fontSize: "0.68rem", padding: "2px 8px" }}>
          <span className="pulse-dot" /> {t("team.live")}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <ClubNameLink clubId={fixture.homeClubId} name={fixture.home} kit={fixture.homeKit} hasCustomLogo={fixture.homeHasCustomLogo} size={22} />
          <span className="score">{fixture.played || isLive ? `${fixture.homeScore ?? 0} - ${fixture.awayScore ?? 0}` : t("team.vs")}</span>
          <ClubNameLink clubId={fixture.awayClubId} name={fixture.away} kit={fixture.awayKit} hasCustomLogo={fixture.awayHasCustomLogo} size={22} />
        </div>
      </div>
    </div>
  );
}
