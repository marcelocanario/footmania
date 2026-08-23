import { useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import { api, type PlayerView } from "../api/client";
import { PlayerSkillsRadar } from "./PlayerSkillsRadar";

export function PlayerDetailsDialog({ target, onClose }: { target: { id: number; name: string } | null; onClose: () => void }) {
  const [player, setPlayer] = useState<PlayerView | null>(null);
  const [busy, setBusy] = useState(false);

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
                <div style={{ color: "var(--text-3)", fontSize: "0.82rem" }}>{player.positionName} · {player.age} yrs · {player.country}</div>
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
          <PlayerSkillsRadar skills={player.skills} />
        </div>
      )}
    </Dialog>
  );
}
