import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import { Toast } from "primereact/toast";
import { Plus, Play, Trash2, Flag, Save } from "lucide-react";
import { api, type ClubOption } from "../api/client";
import { strings } from "../strings";
import { ClubBadge } from "../components/ClubBadge";
import { useGame } from "../store/game";

interface SaveRow {
  id: number;
  name: string;
  year: number;
  dayIndex: number;
  hasHuman: boolean;
  updatedAt: string;
}

export function Saves() {
  const [saves, setSaves] = useState<SaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [clubOptions, setClubOptions] = useState<ClubOption[]>([]);
  const [pickClub, setPickClub] = useState(false);
  const [pickSaveId, setPickSaveId] = useState<number | null>(null);
  const [toStart, setToStart] = useState<number | null>(null);
  const toast = useRef<Toast>(null);
  const navigate = useNavigate();
  const enterSave = useGame((s) => s.enterSave);

  const refresh = async () => {
    setLoading(true);
    try {
      setSaves(await api.listSaves());
    } catch {
      toast.current?.show({ severity: "error", summary: "Error", detail: strings.common.error });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const res = await api.createSave(newName || "New Career");
      setPickSaveId(res.id);
      setClubOptions(res.clubOptions);
      setPickClub(true);
      setNewName("");
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setCreating(false);
    }
  };

  const startExisting = async (saveId: number) => {
    try {
      const res = await api.saveState(saveId);
      if (res.clubOptions) {
        setPickSaveId(saveId);
        setClubOptions(res.clubOptions);
        setPickClub(true);
      }
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const start = async () => {
    if (toStart === null || pickSaveId === null) return;
    try {
      await api.startSave(pickSaveId, toStart);
      enterSave(pickSaveId);
      setPickClub(false);
      navigate("/dashboard");
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const continueSave = (id: number) => {
    enterSave(id);
    navigate("/dashboard");
  };

  const del = async (id: number) => {
    await api.deleteSave(id);
    refresh();
  };

  return (
    <div>
      <Toast ref={toast} />

      <div className="page-head">
        <div>
          <div className="kicker">{strings.saves.startNew}</div>
          <h1>{strings.saves.title}</h1>
        </div>
        <div className="head-actions" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <InputText
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={strings.saves.name}
            onKeyDown={(e) => e.key === "Enter" && create()}
            style={{ minWidth: 180 }}
            aria-label={strings.saves.name}
          />
          <button className="btn" onClick={create} disabled={creating}>
            <Plus size={16} /> {strings.saves.newSave}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">{strings.common.loading}</div>
      ) : saves.length === 0 ? (
        <div className="card empty-state" style={{ padding: "56px 20px" }}>
          <div className="football" />
          <div style={{ fontWeight: 600, color: "var(--text-2)" }}>{strings.saves.noSaves}</div>
          <button className="btn" onClick={create} disabled={creating} style={{ marginTop: 6 }}>
            <Plus size={16} /> {strings.saves.newSave}
          </button>
        </div>
      ) : (
        <div className="grid stagger">
          {saves.map((s) => (
            <div className="card hoverable" key={s.id} style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <span
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 14,
                  display: "grid",
                  placeItems: "center",
                  background: "linear-gradient(180deg, rgba(61,220,132,0.18), rgba(35,165,90,0.1))",
                  border: "1px solid rgba(61,220,132,0.3)",
                  color: "var(--grass-2)",
                  flexShrink: 0,
                }}
              >
                <Save size={20} />
              </span>
              <div style={{ flex: 1, minWidth: 160 }}>
                <h3 style={{ marginBottom: 4 }}>{s.name}</h3>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="chip">Year {s.year}</span>
                  <span className="chip">Day {s.dayIndex}</span>
                  {!s.hasHuman && <span className="chip" style={{ borderColor: "rgba(240,180,41,0.4)", color: "var(--gold-2)" }}>No club chosen</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {s.hasHuman ? (
                  <button className="btn" onClick={() => continueSave(s.id)}>
                    <Play size={15} /> {strings.saves.continue}
                  </button>
                ) : (
                  <button className="btn gold" onClick={() => startExisting(s.id)}>
                    <Flag size={15} /> {strings.saves.pickClub}
                  </button>
                )}
                <button className="icon-btn danger" onClick={() => del(s.id)} title={strings.saves.delete} aria-label={strings.saves.delete}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog header={strings.saves.pickClub} visible={pickClub} onHide={() => { setPickClub(false); setToStart(null); refresh(); }} style={{ width: 660 }}>
        <p style={{ color: "var(--text-2)", marginTop: 0 }}>{strings.saves.pickClubHint}</p>
        <div className="grid cols-2" style={{ maxHeight: 460, overflowY: "auto", paddingRight: 4 }}>
          {clubOptions.map((c) => (
            <div
              key={c.id}
              onClick={() => setToStart(c.id)}
              className="card hoverable"
              role="radio"
              aria-checked={toStart === c.id}
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && setToStart(c.id)}
              style={{
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: 14,
                borderColor: toStart === c.id ? "rgba(240,180,41,0.7)" : "var(--line)",
                boxShadow: toStart === c.id ? "0 0 0 3px rgba(240,180,41,0.18)" : "none",
              }}
            >
              <ClubBadge name={c.name} primary={c.primaryColor} secondary={c.secondaryColor} size={46} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{c.name}</div>
                <div style={{ color: "var(--text-3)", fontSize: "0.84rem", marginTop: 2 }}>
                  Rep {c.reputation} · Level {c.level}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn ghost" onClick={() => setPickClub(false)}>{strings.common.cancel}</button>
          <button className="btn" onClick={start} disabled={toStart === null}>
            <Play size={15} /> {strings.saves.continue}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
