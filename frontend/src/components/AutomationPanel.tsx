import { useEffect, useMemo, useRef, useState } from "react";
import { Toast } from "primereact/toast";
import { InputText } from "primereact/inputtext";
import { Dropdown } from "primereact/dropdown";
import { ChevronDown, Zap } from "lucide-react";
import { api, type PlayerView } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { POSITION_FULL_NAMES } from "./PlayerName";
import { DIRECTIONS, FORMATIONS, PRESSING, STYLES, formationLabel, withUnchanged } from "../tacticsOptions";

/**
 * Match automation editor, scoped to the currently chosen tactic (formation).
 * Rules follow "WHEN <event> IF <score> THEN <sub/tactics>" and fire while the
 * server simulates matches — including when the manager is offline.
 *
 * Presets are strictly bound to one formation each; the engine arms them
 * against the club's saved kickoff formation (backend/src/game/automation.ts).
 */

// Mirrors AUTOMATION_CONFIG in backend/src/config.ts; the server stays authoritative.
const MAX_PRESETS_REGULAR = 1;
const MAX_RULES_PER_PRESET = 6;

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
  formationId: number;
  enabled: boolean;
  rules: Rule[];
}

const TRIGGER_OPTS: { label: string; value: TriggerKind }[] = [
  { label: "A specific minute…", value: "MINUTE" },
  { label: "Half-time", value: "HALF_TIME" },
  { label: "We score a goal", value: "GOAL_SCORED" },
  { label: "We concede a goal", value: "GOAL_CONCEDED" },
  { label: "We get a red card", value: "RED_CARD" },
];

const CONDITION_OPTS: { label: string; value: Condition }[] = [
  { label: "any score", value: "ANY" },
  { label: "we are winning", value: "WINNING" },
  { label: "we are drawing", value: "DRAWING" },
  { label: "we are losing", value: "LOSING" },
  { label: "we are winning by 2+", value: "WINNING_BY_2" },
  { label: "we are losing by 2+", value: "LOSING_BY_2" },
];

const ACTION_OPTS: { label: string; value: ActionKind }[] = [
  { label: "Make a substitution", value: "SUB" },
  { label: "Change tactics", value: "TACTICS" },
];

const MINUTE_OPTS = Array.from({ length: 90 }, (_, i) => ({ label: `${i + 1}'`, value: i + 1 }));

const UNCHANGED_FORMATION = withUnchanged(FORMATIONS);
const UNCHANGED_STYLE = withUnchanged(STYLES);
const UNCHANGED_PRESSING = withUnchanged(PRESSING);
const UNCHANGED_DIRECTION = withUnchanged(DIRECTIONS);

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/** Client-side mirror of the backend rule validation; a non-null message blocks saving. */
function ruleIssue(rule: Rule): string | null {
  if (rule.action.kind === "SUB") {
    if (!rule.action.outPlayerId || !rule.action.inPlayerId) return "Pick the player coming off and the player coming on.";
    if (rule.action.outPlayerId === rule.action.inPlayerId) return "The two players must be different.";
    return null;
  }
  const changed =
    rule.action.formation !== undefined ||
    rule.action.style !== undefined ||
    rule.action.pressing !== undefined ||
    rule.action.direction !== undefined;
  if (!changed) return "Choose at least one tactic change.";
  if (rule.action.formation !== undefined && rule.trigger.kind !== "HALF_TIME") return "Formation changes may only trigger at half-time.";
  return null;
}

function StepLabel({ children }: { children: string }) {
  return <span className="aut-step">{children}</span>;
}

function RuleRow({
  rule,
  squad,
  onChange,
  onRemove,
}: {
  rule: Rule;
  squad: PlayerView[];
  onChange: (next: Rule) => void;
  onRemove: () => void;
}) {
  const playerOptions = useMemo(
    () => squad.map((pl) => ({ label: `${pl.displayName ?? pl.name} · ${POSITION_FULL_NAMES[pl.position] ?? pl.positionName} · ${pl.overall}`, value: pl.id })),
    [squad]
  );
  const issue = ruleIssue(rule);

  const patchAction = (patch: Partial<Rule["action"]>) => onChange({ ...rule, action: { ...rule.action, ...patch } });

  return (
    <div className="card aut-rule" style={{ padding: 12, marginBottom: 8, background: "rgba(255,255,255,0.03)" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <StepLabel>When</StepLabel>
        <Dropdown
          value={rule.trigger.kind}
          onChange={(e) => {
            const kind = e.value === "MINUTE" ? { kind: e.value, minute: rule.trigger.minute ?? 60 } : { kind: e.value };
            // Formation changes are only legal at half-time; drop a stale
            // formation field when the trigger moves away from it.
            const action = kind.kind !== "HALF_TIME" && rule.action.kind === "TACTICS" ? { ...rule.action, formation: undefined } : rule.action;
            onChange({ ...rule, trigger: kind, action });
          }}
          options={TRIGGER_OPTS}
          style={{ minWidth: 190 }}
          aria-label="Trigger event"
        />
        {rule.trigger.kind === "MINUTE" && (
          <Dropdown
            value={rule.trigger.minute ?? 60}
            onChange={(e) => onChange({ ...rule, trigger: { kind: "MINUTE", minute: e.value } })}
            options={MINUTE_OPTS}
            filter
            style={{ width: 110 }}
            aria-label="Minute"
          />
        )}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <StepLabel>If</StepLabel>
        <Dropdown
          value={rule.condition}
          onChange={(e) => onChange({ ...rule, condition: e.value })}
          options={CONDITION_OPTS}
          style={{ minWidth: 190 }}
          aria-label="Score condition"
        />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <StepLabel>Then</StepLabel>
        <Dropdown
          value={rule.action.kind}
          onChange={(e) => onChange({ ...rule, action: { kind: e.value } })}
          options={ACTION_OPTS}
          style={{ minWidth: 190 }}
          aria-label="Action"
        />
        <button className="btn ghost danger sm" onClick={onRemove} style={{ marginLeft: "auto" }} aria-label="Remove rule">
          Remove
        </button>
      </div>

      {rule.action.kind === "SUB" ? (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", paddingLeft: 4, borderLeft: "2px solid var(--line)", marginLeft: 4 }}>
          <Dropdown
            value={rule.action.outPlayerId ?? null}
            onChange={(e) => patchAction(e.value === null ? { outPlayerId: undefined } : { outPlayerId: e.value })}
            options={playerOptions}
            placeholder="On the pitch — comes off"
            showClear
            filter
            style={{ flex: 1, minWidth: 220 }}
          />
          <Dropdown
            value={rule.action.inPlayerId ?? null}
            onChange={(e) => patchAction(e.value === null ? { inPlayerId: undefined } : { inPlayerId: e.value })}
            options={playerOptions}
            placeholder="From the bench — comes on"
            showClear
            filter
            style={{ flex: 1, minWidth: 220 }}
          />
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", paddingLeft: 4, borderLeft: "2px solid var(--line)", marginLeft: 4 }}>
          {rule.trigger.kind === "HALF_TIME" && (
            <Dropdown
              value={rule.action.formation ?? null}
              onChange={(e) => patchAction(e.value === null ? { formation: undefined } : { formation: e.value })}
              options={[...UNCHANGED_FORMATION]}
              placeholder="Formation"
              style={{ minWidth: 160, flex: 1 }}
              aria-label="New formation"
            />
          )}
          <Dropdown
            value={rule.action.style ?? null}
            onChange={(e) => patchAction(e.value === null ? { style: undefined } : { style: e.value })}
            options={[...UNCHANGED_STYLE]}
            placeholder="Style"
            style={{ minWidth: 150, flex: 1 }}
            aria-label="New style"
          />
          <Dropdown
            value={rule.action.pressing ?? null}
            onChange={(e) => patchAction(e.value === null ? { pressing: undefined } : { pressing: e.value })}
            options={[...UNCHANGED_PRESSING]}
            placeholder="Pressing"
            style={{ minWidth: 140, flex: 1 }}
            aria-label="New pressing"
          />
          <Dropdown
            value={rule.action.direction ?? null}
            onChange={(e) => patchAction(e.value === null ? { direction: undefined } : { direction: e.value })}
            options={[...UNCHANGED_DIRECTION]}
            placeholder="Direction"
            style={{ minWidth: 170, flex: 1 }}
            aria-label="New direction"
          />
        </div>
      )}

      {issue && (
        <div style={{ color: "var(--gold-2)", fontSize: "0.8rem", marginTop: 8 }}>
          ⚠ {issue}
        </div>
      )}
    </div>
  );
}

function PresetBlock({
  preset,
  squad,
  maxRules,
  onChange,
  onRemove,
}: {
  preset: Preset;
  squad: PlayerView[];
  maxRules: number;
  onChange: (next: Preset) => void;
  onRemove: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <InputText
          value={preset.name}
          onChange={(e) => onChange({ ...preset, name: e.target.value })}
          placeholder="Rule set name"
          style={{ flex: "1 1 180px" }}
          aria-label="Rule set name"
        />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.85rem", cursor: "pointer" }}>
          <input type="checkbox" checked={preset.enabled} onChange={(e) => onChange({ ...preset, enabled: e.target.checked })} /> Enabled
        </label>
        <span className="chip" title="This rule set only fires when the team starts a match in this formation">
          {formationLabel(preset.formationId)}
        </span>
        <button className="btn ghost danger sm" onClick={onRemove}>
          Delete rule set
        </button>
      </div>

      {preset.rules.length === 0 && (
        <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginBottom: 8 }}>No rules yet — add one below.</div>
      )}

      {preset.rules.map((rule) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          squad={squad}
          onChange={(next) => onChange({ ...preset, rules: preset.rules.map((r) => (r.id === rule.id ? next : r)) })}
          onRemove={() => onChange({ ...preset, rules: preset.rules.filter((r) => r.id !== rule.id) })}
        />
      ))}

      <button
        className="btn ghost sm"
        disabled={preset.rules.length >= maxRules}
        onClick={() =>
          onChange({
            ...preset,
            rules: [...preset.rules, { id: uid(), trigger: { kind: "MINUTE", minute: 60 }, condition: "ANY", action: { kind: "SUB" } }],
          })
        }
      >
        + Add rule ({preset.rules.length}/{maxRules})
      </button>
    </div>
  );
}

export function AutomationPanel({ formation }: { formation: number }) {
  const toast = useRef<Toast>(null);
  const user = useGame((s) => s.user);
  const snap = useGame((s) => s.snapshot);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [openOthers, setOpenOthers] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void api
      .getAutomation()
      .then((res) => {
        // Legacy rows may carry a null scope; treat them as bound to the current tactic.
        setPresets(((res.presets as Preset[]) ?? []).map((p) => ({ ...p, formationId: p.formationId ?? formation })));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const squad = snap?.squad ?? [];
  const isPro = Boolean(user?.isPro);

  const current = presets.find((p) => p.formationId === formation);
  const others = presets.filter((p) => p.formationId !== formation);
  const savedFormation = snap?.club?.tactics?.formation;

  const issues = useMemo(
    () => presets.flatMap((p) => p.rules.map((r) => ruleIssue(r)).filter((msg): msg is string => msg !== null)),
    [presets]
  );
  const canSave = useMemo(() => loaded && issues.length === 0 && dirty, [loaded, issues, dirty]);

  const mutate = (updater: (prev: Preset[]) => Preset[]) => {
    setPresets(updater);
    setDirty(true);
  };

  const addForCurrent = () => {
    mutate((prev) => [...prev, { id: uid(), name: `${formationLabel(formation)} automation`, formationId: formation, enabled: true, rules: [] }]);
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.setAutomation(presets as never);
      setDirty(false);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 3000);
      toast.current?.show({
        severity: "success",
        summary: "Saved",
        detail: "Automation saved. Rules fire while matches are simulated — pause them any time in Live Match.",
        life: 3000,
      });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="card-title"><Zap size={17} /> {strings.squad.automationTitle}</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem" }}>Loading automation…</div>
      </div>
    );
  }

  const quotaBlocked = !isPro && presets.length >= MAX_PRESETS_REGULAR;
  const blockingOther = others[0];

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <Toast ref={toast} position="bottom-right" />
      <h2 className="card-title"><Zap size={17} /> {strings.squad.automationTitle}</h2>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ color: "var(--text-3)", fontSize: "0.85rem", lineHeight: 1.5, maxWidth: 720 }}>
          Rules fire automatically while the server simulates your matches — even when you are offline. While watching live you can pause
          them from the Live Match screen. Changes apply once you press <b>Save</b>.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {justSaved && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--grass-2)", fontWeight: 700, fontSize: "0.9rem", whiteSpace: "nowrap" }}>
              ✓ Automation saved
            </span>
          )}
          <button className={`btn ${dirty ? "gold" : ""}`} onClick={() => void save()} disabled={!canSave || busy} title={issues.length > 0 ? issues[0] : undefined}>
            {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      <div style={{ margin: "10px 0 14px", fontSize: "0.9rem" }}>
        These rules apply when your team kicks off in <b>{formationLabel(formation)}</b>.
        {savedFormation !== undefined && savedFormation !== formation && (
          <span style={{ color: "var(--gold-2)", fontSize: "0.82rem" }}> Not saved yet — save your lineup above to activate it.</span>
        )}
      </div>

      {current ? (
        <div className="card" style={{ padding: 14, background: "rgba(255,255,255,0.02)" }}>
          <PresetBlock
            preset={current}
            squad={squad}
            maxRules={MAX_RULES_PER_PRESET}
            onChange={(next) => mutate((prev) => prev.map((p) => (p.id === current.id ? next : p)))}
            onRemove={() => mutate((prev) => prev.filter((p) => p.id !== current.id))}
          />
        </div>
      ) : (
        <div className="empty-state" style={{ padding: 18 }}>
          No automation for {formationLabel(formation)} yet.
          {quotaBlocked ? (
            <div style={{ marginTop: 8, color: "var(--text-3)" }}>
              You already have a rule set for {blockingOther ? formationLabel(blockingOther.formationId) : "another tactic"}. Regular managers
              keep one rule set; <b>Pro</b> unlocks one per tactic.
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <button className="btn gold" onClick={addForCurrent}>
                <Zap size={14} /> Create automation for {formationLabel(formation)}
              </button>
            </div>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section-label">Other tactics</div>
          {others.map((p) => (
            <div key={p.id} className="card" style={{ padding: 10, marginTop: 8 }}>
              <button
                className="btn ghost sm"
                style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                onClick={() => setOpenOthers((o) => ({ ...o, [p.id]: !o[p.id] }))}
              >
                <span>
                  <ChevronDown size={13} style={{ transform: openOthers[p.id] ? "none" : "rotate(-90deg)", transition: "transform .15s", verticalAlign: "-2px", marginRight: 6 }} />
                  {formationLabel(p.formationId)} · {p.name || "Unnamed"} · {p.rules.length} rule{p.rules.length === 1 ? "" : "s"} ·{" "}
                  {p.enabled ? "on" : "off"}
                </span>
                <span style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>{openOthers[p.id] ? "collapse" : "edit"}</span>
              </button>
              {openOthers[p.id] && (
                <div style={{ marginTop: 10 }}>
                  <PresetBlock
                    preset={p}
                    squad={squad}
                    maxRules={MAX_RULES_PER_PRESET}
                    onChange={(next) => mutate((prev) => prev.map((x) => (x.id === p.id ? next : x)))}
                    onRemove={() => mutate((prev) => prev.filter((x) => x.id !== p.id))}
                  />
                </div>
              )}
            </div>
          ))}
          <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginTop: 6 }}>
            {isPro ? "Pro: one rule set per tactic." : "Regular: one rule set in total. Pro = one per tactic."}
          </div>
        </div>
      )}
    </div>
  );
}
