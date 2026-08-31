import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Toast } from "primereact/toast";
import { InputText } from "primereact/inputtext";
import { Dropdown } from "primereact/dropdown";
import { ChevronDown, Zap } from "lucide-react";
import { api, type PlayerView } from "../api/client";
import { useGame } from "../store/game";
import { positionLabel } from "../positions";
import { directionOptions, pressingOptions, styleOptions, formationsFromSnapshot, withUnchanged, type TacticOption } from "../tacticsOptions";
import i18n from "i18next";

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

const TRIGGER_OPTS = (): { label: string; value: TriggerKind }[] => [
  { label: i18n.t("automation.triggerMinute"), value: "MINUTE" },
  { label: i18n.t("automation.triggerHalfTime"), value: "HALF_TIME" },
  { label: i18n.t("automation.triggerGoalScored"), value: "GOAL_SCORED" },
  { label: i18n.t("automation.triggerGoalConceded"), value: "GOAL_CONCEDED" },
  { label: i18n.t("automation.triggerRedCard"), value: "RED_CARD" },
];

const CONDITION_OPTS = (): { label: string; value: Condition }[] => [
  { label: i18n.t("automation.condAny"), value: "ANY" },
  { label: i18n.t("automation.condWinning"), value: "WINNING" },
  { label: i18n.t("automation.condDrawing"), value: "DRAWING" },
  { label: i18n.t("automation.condLosing"), value: "LOSING" },
  { label: i18n.t("automation.condWinningBy2"), value: "WINNING_BY_2" },
  { label: i18n.t("automation.condLosingBy2"), value: "LOSING_BY_2" },
];

const ACTION_OPTS = (): { label: string; value: ActionKind }[] => [
  { label: i18n.t("automation.actionSub"), value: "SUB" },
  { label: i18n.t("automation.actionTactics"), value: "TACTICS" },
];

const MINUTE_OPTS = Array.from({ length: 90 }, (_, i) => ({ label: `${i + 1}'`, value: i + 1 }));

/** Dropdown menu item for tactic options: label plus optional one-line description. */
function automationItemTemplate(option: TacticOption | { label: string; value: null }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{option.label}</div>
      {"desc" in option && option.desc && <div style={{ fontSize: "0.8rem", opacity: 0.85, marginTop: 2, lineHeight: 1.4 }}>{option.desc}</div>}
    </div>
  );
}

/** Formation label from the backend-owned catalog; the id itself is the fallback. */
function labelOf(formations: TacticOption[], id: number): string {
  return formations.find((f) => f.value === id)?.label ?? i18n.t("tactics.formationFallback", { id });
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/** Client-side mirror of the backend rule validation; a non-null message blocks saving. */
function ruleIssue(rule: Rule): string | null {
  if (rule.action.kind === "SUB") {
    if (!rule.action.outPlayerId || !rule.action.inPlayerId) return i18n.t("automation.issuePickPlayers");
    if (rule.action.outPlayerId === rule.action.inPlayerId) return i18n.t("automation.issueDifferentPlayers");
    return null;
  }
  const changed =
    rule.action.formation !== undefined ||
    rule.action.style !== undefined ||
    rule.action.pressing !== undefined ||
    rule.action.direction !== undefined;
  if (!changed) return i18n.t("automation.issueChooseTactic");
  if (rule.action.formation !== undefined && rule.trigger.kind !== "HALF_TIME") return i18n.t("automation.issueFormationHalftime");
  return null;
}

function StepLabel({ children }: { children: string }) {
  return <span className="aut-step">{children}</span>;
}

function RuleRow({
  rule,
  squad,
  formations,
  onChange,
  onRemove,
}: {
  rule: Rule;
  squad: PlayerView[];
  /** Backend-owned formation catalog (§16.1); the frontend keeps no copy. */
  formations: TacticOption[];
  onChange: (next: Rule) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const playerOptions = useMemo(
    () => squad.map((pl) => {
      const nat = (pl as unknown as { naturalPosition?: string }).naturalPosition;
      const posLabel = positionLabel(nat);
      return { label: `${pl.displayName ?? pl.name} · ${posLabel} · ${pl.overall}`, value: pl.id };
    }),
    [squad]
  );
  const issue = ruleIssue(rule);

  const patchAction = (patch: Partial<Rule["action"]>) => onChange({ ...rule, action: { ...rule.action, ...patch } });

  return (
    <div className="card aut-rule" style={{ padding: 12, marginBottom: 8, background: "rgba(255,255,255,0.03)" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <StepLabel>{t("automation.when")}</StepLabel>
        <Dropdown
          value={rule.trigger.kind}
          onChange={(e) => {
            const kind = e.value === "MINUTE" ? { kind: e.value, minute: rule.trigger.minute ?? 60 } : { kind: e.value };
            // Formation changes are only legal at half-time; drop a stale
            // formation field when the trigger moves away from it.
            const action = kind.kind !== "HALF_TIME" && rule.action.kind === "TACTICS" ? { ...rule.action, formation: undefined } : rule.action;
            onChange({ ...rule, trigger: kind, action });
          }}
          options={TRIGGER_OPTS()}
          style={{ minWidth: 190 }}
          aria-label={t("automation.triggerAria")}
        />
        {rule.trigger.kind === "MINUTE" && (
          <Dropdown
            value={rule.trigger.minute ?? 60}
            onChange={(e) => onChange({ ...rule, trigger: { kind: "MINUTE", minute: e.value } })}
            options={MINUTE_OPTS}
            filter
            style={{ width: 110 }}
            aria-label={t("automation.minuteAria")}
          />
        )}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <StepLabel>{t("automation.if")}</StepLabel>
        <Dropdown
          value={rule.condition}
          onChange={(e) => onChange({ ...rule, condition: e.value })}
          options={CONDITION_OPTS()}
          style={{ minWidth: 190 }}
          aria-label={t("automation.conditionAria")}
        />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <StepLabel>{t("automation.then")}</StepLabel>
        <Dropdown
          value={rule.action.kind}
          onChange={(e) => onChange({ ...rule, action: { kind: e.value } })}
          options={ACTION_OPTS()}
          style={{ minWidth: 190 }}
          aria-label={t("automation.actionAria")}
        />
        <button className="btn ghost danger sm" onClick={onRemove} style={{ marginLeft: "auto" }} aria-label={t("automation.removeRuleAria")}>
          {t("automation.remove")}
        </button>
      </div>

      {rule.action.kind === "SUB" ? (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", paddingLeft: 4, borderLeft: "2px solid var(--line)", marginLeft: 4 }}>
          <Dropdown
            value={rule.action.outPlayerId ?? null}
            onChange={(e) => patchAction(e.value === null ? { outPlayerId: undefined } : { outPlayerId: e.value })}
            options={playerOptions}
            placeholder={t("automation.offPlaceholder")}
            showClear
            filter
            style={{ flex: 1, minWidth: 220 }}
          />
          <Dropdown
            value={rule.action.inPlayerId ?? null}
            onChange={(e) => patchAction(e.value === null ? { inPlayerId: undefined } : { inPlayerId: e.value })}
            options={playerOptions}
            placeholder={t("automation.onPlaceholder")}
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
              options={[...withUnchanged(formations)]}
              placeholder={t("automation.formationPlaceholder")}
              style={{ minWidth: 160, flex: 1 }}
              aria-label={t("automation.formationAria")}
            />
          )}
          <Dropdown
            value={rule.action.style ?? null}
            onChange={(e) => patchAction(e.value === null ? { style: undefined } : { style: e.value })}
            options={[...withUnchanged(styleOptions())]}
            placeholder={t("automation.stylePlaceholder")}
            style={{ minWidth: 150, flex: 1 }}
            aria-label={t("automation.styleAria")}
            itemTemplate={automationItemTemplate}
          />
          <Dropdown
            value={rule.action.pressing ?? null}
            onChange={(e) => patchAction(e.value === null ? { pressing: undefined } : { pressing: e.value })}
            options={[...withUnchanged(pressingOptions())]}
            placeholder={t("automation.pressingPlaceholder")}
            style={{ minWidth: 140, flex: 1 }}
            aria-label={t("automation.pressingAria")}
            itemTemplate={automationItemTemplate}
          />
          <Dropdown
            value={rule.action.direction ?? null}
            onChange={(e) => patchAction(e.value === null ? { direction: undefined } : { direction: e.value })}
            options={[...withUnchanged(directionOptions())]}
            placeholder={t("automation.directionPlaceholder")}
            style={{ minWidth: 170, flex: 1 }}
            aria-label={t("automation.directionAria")}
            itemTemplate={automationItemTemplate}
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
  formations,
  maxRules,
  onChange,
  onRemove,
  customTooltips,
}: {
  preset: Preset;
  squad: PlayerView[];
  formations: TacticOption[];
  maxRules: number;
  onChange: (next: Preset) => void;
  onRemove: () => void;
  customTooltips: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <InputText
          value={preset.name}
          onChange={(e) => onChange({ ...preset, name: e.target.value })}
          placeholder={t("automation.ruleSetName")}
          style={{ flex: "1 1 180px" }}
          aria-label={t("automation.ruleSetName")}
        />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.85rem", cursor: "pointer" }}>
          <input type="checkbox" checked={preset.enabled} onChange={(e) => onChange({ ...preset, enabled: e.target.checked })} /> {t("automation.enabled")}
        </label>
        <span className={`chip${customTooltips ? " squad-tooltip-trigger" : ""}`} {...(customTooltips ? { "data-pr-tooltip": t("automation.formationScopeTooltip") } : { title: t("automation.formationScopeTooltip") })}>
          {labelOf(formations, preset.formationId)}
        </span>
        <button className="btn ghost danger sm" onClick={onRemove}>
          {t("automation.deleteRuleSet")}
        </button>
      </div>

      {preset.rules.length === 0 && (
        <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginBottom: 8 }}>{t("automation.noRulesYet")}</div>
      )}

      {preset.rules.map((rule) => (
        <RuleRow
          formations={formations}
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
        + {t("automation.addRule", { count: preset.rules.length, max: maxRules })}
      </button>
    </div>
  );
}

export function AutomationPanel({ formation, customTooltips = false }: { formation: number; customTooltips?: boolean }) {
  const { t } = useTranslation();
  const toast = useRef<Toast>(null);
  const user = useGame((s) => s.user);
  const snap = useGame((s) => s.snapshot);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [openOthers, setOpenOthers] = useState<Record<string, boolean>>({});
  // §16.1: formation options come from the authenticated snapshot, never a
  // local table.
  const formations = useMemo(() => formationsFromSnapshot(snap?.formationOptions), [snap?.formationOptions]);
  const formationName = (id: number) => labelOf(formations, id);

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
    mutate((prev) => [...prev, { id: uid(), name: t("automation.defaultName", { formation: formationName(formation) }), formationId: formation, enabled: true, rules: [] }]);
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
        summary: t("automation.savedSummary"),
        detail: t("automation.savedDetail"),
        life: 3000,
      });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("automation.error"), detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="card-title"><Zap size={17} /> {t("squad.automationTitle")}</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem" }}>{t("automation.loading")}</div>
      </div>
    );
  }

  const quotaBlocked = !isPro && presets.length >= MAX_PRESETS_REGULAR;
  const blockingOther = others[0];

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <Toast ref={toast} position="bottom-right" />
      <h2 className="card-title"><Zap size={17} /> {t("squad.automationTitle")}</h2>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ color: "var(--text-3)", fontSize: "0.85rem", lineHeight: 1.5, maxWidth: 720 }}>
          {t("automation.intro")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {justSaved && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--grass-2)", fontWeight: 700, fontSize: "0.9rem", whiteSpace: "nowrap" }}>
              {t("automation.savedCheck")}
            </span>
          )}
          <button className={`btn ${dirty ? "gold" : ""}${customTooltips && issues.length > 0 ? " squad-tooltip-trigger" : ""}`} onClick={() => void save()} disabled={!canSave || busy} {...(customTooltips ? { "data-pr-tooltip": issues.length > 0 ? issues[0] : undefined } : { title: issues.length > 0 ? issues[0] : undefined })}>
            {busy ? t("automation.saving") : dirty ? t("automation.saveChanges") : t("automation.saved")}
          </button>
        </div>
      </div>

      <div style={{ margin: "10px 0 14px", fontSize: "0.9rem" }}>
        {t("automation.appliesIn", { formation: formationName(formation) })}
        {savedFormation !== undefined && savedFormation !== formation && (
          <span style={{ color: "var(--gold-2)", fontSize: "0.82rem" }}>{t("automation.notSavedYet")}</span>
        )}
      </div>

      {current ? (
        <div className="card" style={{ padding: 14, background: "rgba(255,255,255,0.02)" }}>
          <PresetBlock
            preset={current}
            squad={squad}
            formations={formations}
            maxRules={MAX_RULES_PER_PRESET}
            onChange={(next) => mutate((prev) => prev.map((p) => (p.id === current.id ? next : p)))}
            onRemove={() => mutate((prev) => prev.filter((p) => p.id !== current.id))}
            customTooltips={customTooltips}
          />
        </div>
      ) : (
        <div className="empty-state" style={{ padding: 18 }}>
          {t("automation.noneFor", { formation: formationName(formation) })}
          {quotaBlocked ? (
            <div style={{ marginTop: 8, color: "var(--text-3)" }}>
              {t("automation.quotaBlocked", { other: blockingOther ? formationName(blockingOther.formationId) : t("automation.anotherTactic") })}
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <button className="btn gold" onClick={addForCurrent}>
                <Zap size={14} /> {t("automation.createAutomation", { formation: formationName(formation) })}
              </button>
            </div>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section-label">{t("automation.otherTactics")}</div>
          {others.map((p) => (
            <div key={p.id} className="card" style={{ padding: 10, marginTop: 8 }}>
              <button
                className="btn ghost sm"
                style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                onClick={() => setOpenOthers((o) => ({ ...o, [p.id]: !o[p.id] }))}
              >
                <span>
                  <ChevronDown size={13} style={{ transform: openOthers[p.id] ? "none" : "rotate(-90deg)", transition: "transform .15s", verticalAlign: "-2px", marginRight: 6 }} />
                  {formationName(p.formationId)} · {p.name || t("automation.unnamed")} · {t("automation.ruleCount", { count: p.rules.length })} ·{" "}
                  {p.enabled ? t("automation.on") : t("automation.off")}
                </span>
                <span style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>{openOthers[p.id] ? t("automation.collapse") : t("automation.edit")}</span>
              </button>
              {openOthers[p.id] && (
                <div style={{ marginTop: 10 }}>
                  <PresetBlock
                    preset={p}
                    squad={squad}
                    formations={formations}
                    maxRules={MAX_RULES_PER_PRESET}
                    onChange={(next) => mutate((prev) => prev.map((x) => (x.id === p.id ? next : x)))}
                    onRemove={() => mutate((prev) => prev.filter((x) => x.id !== p.id))}
                    customTooltips={customTooltips}
                  />
                </div>
              )}
            </div>
          ))}
          <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginTop: 6 }}>
            {isPro ? t("automation.proPerTactic") : t("automation.regularPerTactic")}
          </div>
        </div>
      )}
    </div>
  );
}
