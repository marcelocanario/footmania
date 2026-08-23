import { useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import { api, type PlayerHistoryView } from "../api/client";
import { useGame } from "../store/game";
import { countryFlag } from "../countryFlags";
import { ClubNameLink } from "./ClubNameLink";
import { PlayerSkillsRadar } from "./PlayerSkillsRadar";

export function PlayerDetailsDialog({ target, onClose }: { target: { id: number; name: string } | null; onClose: () => void }) {
  const [player, setPlayer] = useState<PlayerHistoryView | null>(null);
  const [busy, setBusy] = useState(false);
  const user = useGame((state) => state.user);

  useEffect(() => {
    if (!target) {
      setPlayer(null);
      return;
    }
    setBusy(true);
    setPlayer(null);
    api.playerHistory(target.id)
      .then((result) => setPlayer(result.player))
      .catch(() => setPlayer(null))
      .finally(() => setBusy(false));
  }, [target]);

  const ownTeam = player?.isOwnTeam ?? false;
  const canSeeSkills = Boolean(player?.skills) && (ownTeam || Boolean(user?.isPro));
  const country = player ? countryFlag(player.country) : null;

  return (
    <Dialog header={player ? (player.displayName ?? player.name) : target?.name ?? "Player details"} visible={target !== null} onHide={onClose} style={{ width: 520 }}>
      {!player ? (
        <div className="empty-state" style={{ padding: 20 }}>{busy ? "Loading…" : "Player details unavailable."}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: "1.1rem" }}>{player.displayName ?? player.name}</div>
                <div style={{ color: "var(--text-2)", fontSize: "0.84rem", marginTop: 3 }}>
                  {player.clubId != null
                    ? <ClubNameLink clubId={player.clubId} name={player.clubName ?? ""} showCrest={false} />
                    : player.clubName ?? "Free agent"}
                </div>
                <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 2 }}>
                  {player.positionName} · {player.age} yrs · <span title={player.country} aria-label={`Country: ${player.country}`}>{country ? `${country} ` : ""}{player.country}</span>
                </div>
              </div>
              <strong style={{ fontSize: "1.5rem", fontFamily: "var(--font-display)" }}>{player.overall}</strong>
            </div>
            <div className="stats-row" style={{ marginTop: 12 }}>
              <div className="stat"><div className="label">Energy</div><div className="value">{Math.round(player.energy)}</div></div>
              <div className="stat"><div className="label">This season</div><div className="value">{player.seasonGoals}G {player.seasonAssists}A</div></div>
              <div className="stat"><div className="label">Career</div><div className="value">{player.careerGoals}G {player.careerAssists}A</div></div>
              <div className="stat"><div className="label">Discipline</div><div className="value">{player.yellows}Y {player.reds}R</div></div>
            </div>
          </div>
          <div className="player-skills-panel">
            {!ownTeam && <span className="pro-feature-pill">PRO</span>}
            {canSeeSkills && player.skills ? <PlayerSkillsRadar skills={player.skills} /> : !ownTeam ? <div className="empty-state" style={{ padding: 18 }}>Player skills are available to Pro managers.</div> : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}
