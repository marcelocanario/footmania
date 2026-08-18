import { useEffect, useState } from "react";
import { FastForward, RefreshCw, Undo2 } from "lucide-react";
import { api } from "../api/client";
import { useGame } from "../store/game";

interface AdminWorld {
  seasonKey: string;
  seasonStatus: string;
  completedRounds: number;
  joinState: string;
  joinLockRound: number;
  manualRound: number | null;
  realCompletedRounds: number;
  divisionCount: number;
  clubCount: number;
  humanClubCount: number;
  liveMatchCount: number;
}

export function Admin() {
  const { user } = useGame();
  const [world, setWorld] = useState<AdminWorld | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetRound, setTargetRound] = useState(14);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.adminStatus();
      setWorld(res.world);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setLoading(true);
    setMessage(null);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!user?.isAdmin) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        Admins only
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">Admin</div>
          <h1>Multiplayer Clock</h1>
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {error && <div className="card" style={{ borderColor: "rgba(255,99,99,0.5)", color: "#ff6b6b", marginBottom: 12 }}>{error}</div>}
      {message && <div className="card" style={{ borderColor: "rgba(61,220,132,0.5)", color: "var(--grass-2)", marginBottom: 12 }}>{message}</div>}

      {world && (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 12, marginBottom: 16 }}>
          <div className="card" style={{ padding: 14 }}>
            <div className="kicker">Season</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>{world.seasonKey}</div>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>{world.seasonStatus}</div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="kicker">Rounds</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>{world.completedRounds}<span style={{ color: "var(--text-3)", fontSize: "0.9rem" }}> / 14</span></div>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>join lock at {world.joinLockRound}</div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="kicker">Join state</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>{world.joinState}</div>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>manual: {world.manualRound ?? "off"}</div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="kicker">World</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>{world.humanClubCount} human</div>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>{world.clubCount} clubs · {world.divisionCount} divisions · {world.liveMatchCount} live</div>
          </div>
        </div>
      )}

      <div className="card" style={{ maxWidth: 620, padding: 20 }}>
        <h3 style={{ marginBottom: 10 }}>Manual clock</h3>
        <div style={{ color: "var(--text-2)", marginBottom: 16, fontSize: "0.9rem" }}>
          Instantly simulate every division through the requested round. While manual mode is set, the real schedule is paused and the manual round is authoritative.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn gold" disabled={loading} onClick={() => void run(() => api.adminAdvanceRound(targetRound))}>
            <FastForward size={15} /> Advance to round
          </button>
          <input
            type="number"
            min={1}
            max={14}
            value={targetRound}
            onChange={(e) => setTargetRound(Number(e.target.value))}
            style={{ width: 90, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
          />
          <button className="btn" disabled={loading} onClick={() => void run(() => api.adminSetRound(targetRound))}>
            Set manual round
          </button>
          <button className="btn" disabled={loading} onClick={() => void run(async () => { await api.adminClearManual(); setMessage("Manual mode cleared — real schedule resumed."); })}>
            <Undo2 size={15} /> Clear manual
          </button>
          <button className="btn" disabled={loading} onClick={() => void run(async () => { await api.adminRollover(); setMessage("Rollover forced."); })}>
            <RefreshCw size={15} /> Force rollover
          </button>
        </div>
      </div>
    </div>
  );
}
