import { useEffect, useRef, useState } from "react";
import { Toast } from "primereact/toast";
import { InputText } from "primereact/inputtext";
import { Dropdown } from "primereact/dropdown";
import { api, type PlayerView } from "../api/client";
import { useGame } from "../store/game";

type TriggerKind = "MINUTE" | "HALF_TIME" | "GOAL_SCORED" | "GOAL_CONCEDED" | "RED_CARD";
type Condition = "ANY" | "WINNING" | "LOSING" | "DRAWING" | "WINNING_BY_2" | "LOSING_BY_2";
type ActionKind = "SUB" | "TACTICS";

interface Rule {
  id: string;
  trigger: { kind: TriggerKind; minute?: number };
  condition: Condition;
  action: { kind: ActionKind; outPlayerId?: number; inPlayerId?: number; formation?: number; style?: number; pressing?: number; direction?: number };
}
interface Preset {
  id: string;
  name: string;
  formationId: number | null;
  enabled: boolean;
  rules: Rule[];
}

const TRIGGER_OPTS: { label: string; value: TriggerKind }[] = [
  { label: "at minute…", value: "MINUTE" },
  { label: "at half-time", value: "HALF_TIME" },
  { label: "when we score", value: "GOAL_SCORED" },
  { label: "when we concede", value: "GOAL_CONCEDED" },
  { label: "when we get a red", value: "RED_CARD" },
];
const COND_OPTS: { label: string; value: Condition }[] = [
  { label: "always", value: "ANY" },
  { label: "if winning", value: "WINNING" },
  { label: "if losing", value: "LOSING" },
  { label: "if drawing", value: "DRAWING" },
  { label: "if winning by 2+", value: "WINNING_BY_2" },
  { label: "if losing by 2+", value: "LOSING_BY_2" },
];
const ACTION_OPTS: { label: string; value: ActionKind }[] = [
  { label: "sub", value: "SUB" },
  { label: "change tactics", value: "TACTICS" },
];

function uid() { return Math.random().toString(36).slice(2, 9); }

export function Automation() {
  const toast = useRef<Toast>(null);
  const user = useGame((s) => s.user);
  const snap = useGame((s) => s.snapshot);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const squad = snap?.squad ?? [];

  useEffect(() => {
    void api.getAutomation().then((res) => { setPresets((res.presets as Preset[]) ?? []); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await api.setAutomation(presets as never);
      toast.current?.show({ severity: "success", summary: "Saved", detail: "Automation presets saved. They fire when you are not watching live (or until you pause them in Live Match).", life: 3000 });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally { setBusy(false); }
  };

  const addPreset = () => {
    const isPro = Boolean(user?.isPro);
    if (!isPro && presets.length >= 1) { toast.current?.show({ severity: "warn", summary: "Regular limit", detail: "Regular managers may save 1 preset. Upgrade to Pro for one per formation." }); return; }
    setPresets((p) => [...p, { id: uid(), name: `Preset ${p.length + 1}`, formationId: null, enabled: true, rules: [] }]);
  };
  const removePreset = (id: string) => setPresets((p) => p.filter((x) => x.id !== id));
  const addRule = (pid: string) => setPresets((ps) => ps.map((pr) => pr.id === pid ? { ...pr, rules: [...pr.rules, { id: uid(), trigger: { kind: "MINUTE", minute: 60 }, condition: "ANY", action: { kind: "SUB" } }] } : pr));
  const removeRule = (pid: string, rid: string) => setPresets((ps) => ps.map((pr) => pr.id === pid ? { ...pr, rules: pr.rules.filter((r) => r.id !== rid) } : pr));

  if (!loaded) return <div className="empty-state" style={{ paddingTop: 60 }}>Loading presets…</div>;

  const isPro = Boolean(user?.isPro);

  return (
    <div>
      <Toast ref={toast} />
      <div className="page-head">
        <div>
          <div className="kicker">Match automation</div>
          <h1>Auto-presets</h1>
          <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginTop: 6 }}>“At <em>event</em> if <em>condition</em> do <em>action</em>” — e.g. <em>at minute 60 if losing do sub A for B</em>. Fires while the server simulates; pause with the “Pause automation” button when you are watching live.</div>
          <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 6 }}>{isPro ? "Pro: one preset per formation." : "Regular: one preset total. Pro = one per formation."}</div>
        </div>
        <button className="btn gold" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save all"}</button>
      </div>

      {presets.length === 0 && <div className="empty-state" style={{ padding: 18 }}>No presets yet. Create one to automate subs/tactics when you cannot watch.</div>}

      {presets.map((preset) => (
        <div key={preset.id} className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <InputText value={preset.name} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, name: e.target.value } : p))} placeholder="Preset name" style={{ flex: "1 1 200px" }} />
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.85rem" }}><input type="checkbox" checked={preset.enabled} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, enabled: e.target.checked } : p))} /> Enabled</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: "0.82rem", color: "var(--text-3)" }}>Formation</span>
              <Dropdown value={preset.formationId} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, formationId: e.value } : p))} options={[{ label: "Any", value: null }, ...Array.from({ length: 6 }, (_, i) => ({ label: `Formation ${i}`, value: i }))]} style={{ minWidth: 140 }} placeholder="Any" />
            </div>
            <button className="btn ghost danger" onClick={() => removePreset(preset.id)}>Delete preset</button>
          </div>

          {preset.rules.length === 0 && <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginBottom: 8 }}>No rules — add one below. “At <em>event</em> if <em>condition</em> do <em>action</em>”.</div>}

          {preset.rules.map((rule) => (
            <div key={rule.id} className="card" style={{ padding: 10, marginBottom: 8, background: "rgba(255,255,255,0.03)" }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: "0.82rem", color: "var(--text-3)" }}>At</span>
                <Dropdown value={rule.trigger.kind} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, trigger: { ...r.trigger, kind: e.value } } : r) } : p))} options={TRIGGER_OPTS} style={{ minWidth: 160 }} />
                {rule.trigger.kind === "MINUTE" && <InputText type="number" value={String(rule.trigger.minute ?? 60)} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, trigger: { ...r.trigger, minute: Math.max(1, Math.min(90, Number(e.target.value) || 1)) } } : r) } : p))} style={{ width: 80 }} min={1} max={90} />}
                <span style={{ fontSize: "0.82rem", color: "var(--text-3)" }}>if</span>
                <Dropdown value={rule.condition} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, condition: e.value } : r) } : p))} options={COND_OPTS} style={{ minWidth: 160 }} />
                <span style={{ fontSize: "0.82rem", color: "var(--text-3)" }}>do</span>
                <Dropdown value={rule.action.kind} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, action: { ...r.action, kind: e.value } } : r) } : p))} options={ACTION_OPTS} style={{ minWidth: 160 }} />
                <button className="btn ghost" onClick={() => removeRule(preset.id, rule.id)} style={{ marginLeft: "auto" }}>Remove</button>
              </div>

              {rule.action.kind === "SUB" && (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <Dropdown value={rule.action.outPlayerId ?? null} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, action: { ...r.action, outPlayerId: e.value } } : r) } : p))} options={squad.map((pl: PlayerView) => ({ label: `${pl.displayName ?? pl.name} (${pl.positionName})`, value: pl.id }))} placeholder="Out: player on pitch" style={{ flex: 1 }} showClear filter />
                  <Dropdown value={rule.action.inPlayerId ?? null} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, action: { ...r.action, inPlayerId: e.value } } : r) } : p))} options={squad.map((pl: PlayerView) => ({ label: `${pl.displayName ?? pl.name} (${pl.positionName})`, value: pl.id }))} placeholder="In: bench player" style={{ flex: 1 }} showClear filter />
                </div>
              )}
              {rule.action.kind === "TACTICS" && (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <InputText placeholder="Formation id (0..5)" value={rule.action.formation !== undefined ? String(rule.action.formation) : ""} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, action: { ...r.action, formation: e.target.value === "" ? undefined : Number(e.target.value) } } : r) } : p))} style={{ width: 140 }} />
                  <InputText placeholder="Style 0..2" value={rule.action.style !== undefined ? String(rule.action.style) : ""} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, action: { ...r.action, style: e.target.value === "" ? undefined : Number(e.target.value) } } : r) } : p))} style={{ width: 120 }} />
                  <InputText placeholder="Press 0..5" value={rule.action.pressing !== undefined ? String(rule.action.pressing) : ""} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, action: { ...r.action, pressing: e.target.value === "" ? undefined : Number(e.target.value) } } : r) } : p))} style={{ width: 120 }} />
                  <InputText placeholder="Dir 0..1" value={rule.action.direction !== undefined ? String(rule.action.direction) : ""} onChange={(e) => setPresets((ps) => ps.map((p) => p.id === preset.id ? { ...p, rules: p.rules.map((r) => r.id === rule.id ? { ...r, action: { ...r.action, direction: e.target.value === "" ? undefined : Number(e.target.value) } } : r) } : p))} style={{ width: 120 }} />
                  <span style={{ fontSize: "0.75rem", color: "var(--text-3)", alignSelf: "center" }}>Empty = unchanged.</span>
                </div>
              )}
            </div>
          ))}
          <button className="btn ghost" onClick={() => addRule(preset.id)}>+ Add rule (at … if … do …)</button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn" onClick={addPreset}>+ New preset</button>
        <button className="btn gold" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save all"}</button>
      </div>
    </div>
  );
}
