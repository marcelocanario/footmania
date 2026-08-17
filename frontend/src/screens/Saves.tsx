import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { InputText } from "primereact/inputtext";
import { Toast } from "primereact/toast";
import { Plus, Play, Trash2, Flag, Save, Palette, Home, Info } from "lucide-react";
import { api, type CountryOption } from "../api/client";
import { strings } from "../strings";
import { useGame } from "../store/game";

interface SaveRow {
  id: number;
  name: string;
  year: number;
  dayIndex: number;
  hasHuman: boolean;
  updatedAt: string;
}

interface CountryGroup {
  label: string;
  items: CountryOption[];
}

export function Saves() {
  const [saves, setSaves] = useState<SaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [featured, setFeatured] = useState<CountryOption[]>([]);
  const [createTeam, setCreateTeam] = useState(false);
  const [pickSaveId, setPickSaveId] = useState<number | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [starting, setStarting] = useState(false);
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

  const openCreateTeam = async (saveId: number) => {
    try {
      const res = await api.saveState(saveId);
      if (!res.started) {
        setPickSaveId(saveId);
        setFeatured(res.featuredCountries ?? []);
        setCountries(res.allCountries ?? []);
        setSelectedCountry(null);
        setTeamName("");
        setCreateTeam(true);
      }
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      const res = await api.createSave(newName || "New Career");
      setNewName("");
      await openCreateTeam(res.id);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setCreating(false);
    }
  };

  const startExisting = async (saveId: number) => {
    await openCreateTeam(saveId);
  };

  const start = async () => {
    if (pickSaveId === null || selectedCountry === null) return;
    setStarting(true);
    try {
      await api.startSave(pickSaveId, selectedCountry, teamName.trim() || undefined);
      enterSave(pickSaveId);
      setCreateTeam(false);
      navigate("/dashboard");
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
      setStarting(false);
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

  const countryGroups: CountryGroup[] = [
    { label: "Featured", items: featured },
    { label: "All countries", items: countries },
  ];
  const countryOptions = countryGroups
    .map((g) => ({ label: g.label, items: g.items.map((c) => ({ label: c.name, value: c.code })) }))
    .filter((g) => g.items.length > 0);

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
                  {!s.hasHuman && <span className="chip" style={{ borderColor: "rgba(240,180,41,0.4)", color: "var(--gold-2)" }}>No team created</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {s.hasHuman ? (
                  <button className="btn" onClick={() => continueSave(s.id)}>
                    <Play size={15} /> {strings.saves.continue}
                  </button>
                ) : (
                  <button className="btn gold" onClick={() => startExisting(s.id)}>
                    <Flag size={15} /> {strings.saves.createTeam}
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

      <Dialog header={strings.saves.createTeam} visible={createTeam} onHide={() => { setCreateTeam(false); refresh(); }} style={{ width: 560 }}>
        <p style={{ color: "var(--text-2)", marginTop: 0 }}>{strings.saves.createTeamHint}</p>

        <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
          {strings.saves.country}
        </label>
        <Dropdown
          value={selectedCountry}
          options={countryOptions}
          optionGroupLabel="label"
          optionGroupChildren="items"
          onChange={(e) => setSelectedCountry(e.value)}
          filter
          filterBy="label"
          showClear
          placeholder="Select country"
          style={{ width: "100%" }}
          aria-label={strings.saves.country}
        />

        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <div>
            <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
              {strings.saves.teamName}
            </label>
            <span className="p-input-icon-left" style={{ width: "100%" }}>
              <Flag size={15} />
              <InputText
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder={strings.saves.teamNamePlaceholder}
                style={{ width: "100%" }}
              />
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
                {strings.saves.colors}
              </label>
              <span className="p-input-icon-left" style={{ width: "100%" }}>
                <Palette size={15} />
                <InputText placeholder={strings.saves.colorsPlaceholder} disabled style={{ width: "100%", opacity: 0.65 }} />
              </span>
            </div>
            <div>
              <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
                {strings.saves.stadium}
              </label>
              <span className="p-input-icon-left" style={{ width: "100%" }}>
                <Home size={15} />
                <InputText placeholder={strings.saves.stadiumPlaceholder} disabled style={{ width: "100%", opacity: 0.65 }} />
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-3)", fontSize: "0.85rem" }}>
            <Info size={14} /> {strings.saves.multiplayerHint}
          </div>
        </div>

        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn ghost" onClick={() => setCreateTeam(false)}>{strings.common.cancel}</button>
          <button className="btn" onClick={start} disabled={selectedCountry === null || starting}>
            <Play size={15} /> {starting ? strings.common.loading : strings.saves.continue}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
