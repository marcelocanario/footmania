import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Toast } from "primereact/toast";
import { InputText } from "primereact/inputtext";
import { InputNumber } from "primereact/inputnumber";
import { MultiSelect } from "primereact/multiselect";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { ChevronDown, Zap, ArrowUp, ArrowDown, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { api, type LineupView, type PlayerView } from "../api/client";
import { useGame } from "../store/game";
import { positionLabel } from "../positions";
import { directionOptions, pressingOptions, styleOptions, formationsFromSnapshot, withUnchanged, type TacticOption } from "../tacticsOptions";
import i18n from "i18next";

/**
 * Match automation editor, scoped to the currently chosen tactic (formation).
 * A rule reads like a small recipe card: WHEN <trigger> [in minutes X-Y],
 * IF <conditions>, THEN <one or more actions, all run in order>. Rules fire
 * while the server simulates matches — including when the manager is offline.
 * See backend/src/game/automation.ts for the evaluation engine and
 * BUSINESS_RULES.md §11 for the governing spec.
 *
 * Presets are strictly bound to one formation each; the engine arms them
 * against the club's saved kickoff formation. Caps (preset/rule/action/
 * maxFires limits) and the full trigger/condition/action/selector
 * vocabularies are backend-owned (services/snapshot.ts automationConfig) —
 * this file supplies only the i18n label for each value, never a numeric limit.
 */

type TriggerKind =
  | "MINUTE"
  | "HALF_TIME"
  | "GOAL_SCORED"
  | "GOAL_CONCEDED"
  | "RED_CARD"
  | "YELLOW_CARD"
  | "OPPONENT_RED_CARD"
  | "PLAYER_INJURED"
  | "MISSED_PENALTY";
type Condition =
  | "ANY"
  | "WINNING"
  | "LOSING"
  | "DRAWING"
  | "WINNING_BY_2"
  | "LOSING_BY_2"
  | "WINNING_OR_DRAWING"
  | "LOSING_OR_DRAWING"
  | "A_MAN_DOWN"
  | "A_MAN_UP"
  | "TIRED_PLAYER_ON_PITCH"
  | "BOOKED_PLAYER_ON_PITCH"
  | "HAS_SUBS_LEFT"
  | "LOSING_POSSESSION";
type ActionKind = "SUB" | "TACTICS" | "SET_TAKER" | "SWAP_SLOTS" | "STOP_AUTOMATION" | "HALFTIME_READY";
type OutSelect = "PLAYER" | "SLOT" | "MOST_TIRED" | "BOOKED";
type InSelect = "PLAYER" | "BEST_FOR_ROLE";

interface Action {
  kind: ActionKind;
  outPlayerId?: number;
  inPlayerId?: number;
  outSelect?: OutSelect;
  inSelect?: InSelect;
  outSlotIndex?: number;
  formation?: number;
  style?: number;
  pressing?: number;
  direction?: number;
  swapPlayerAId?: number;
  swapPlayerBId?: number;
  takerPlayerId?: number;
}

interface Rule {
  id: string;
  trigger: { kind: TriggerKind; minute?: number };
  conditions: Condition[];
  fromMinute?: number;
  toMinute?: number;
  maxFires?: number;
  /** Every action here runs, in order, when the rule fires — see §11. */
  actions: Action[];
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
  { label: i18n.t("automation.triggerYellowCard"), value: "YELLOW_CARD" },
  { label: i18n.t("automation.triggerOpponentRedCard"), value: "OPPONENT_RED_CARD" },
  { label: i18n.t("automation.triggerPlayerInjured"), value: "PLAYER_INJURED" },
  { label: i18n.t("automation.triggerMissedPenalty"), value: "MISSED_PENALTY" },
];

const CONDITION_OPTS = (): { label: string; value: Condition }[] => [
  { label: i18n.t("automation.condAny"), value: "ANY" },
  { label: i18n.t("automation.condWinning"), value: "WINNING" },
  { label: i18n.t("automation.condDrawing"), value: "DRAWING" },
  { label: i18n.t("automation.condLosing"), value: "LOSING" },
  { label: i18n.t("automation.condWinningBy2"), value: "WINNING_BY_2" },
  { label: i18n.t("automation.condLosingBy2"), value: "LOSING_BY_2" },
  { label: i18n.t("automation.condWinningOrDrawing"), value: "WINNING_OR_DRAWING" },
  { label: i18n.t("automation.condLosingOrDrawing"), value: "LOSING_OR_DRAWING" },
  { label: i18n.t("automation.condAManDown"), value: "A_MAN_DOWN" },
  { label: i18n.t("automation.condAManUp"), value: "A_MAN_UP" },
  { label: i18n.t("automation.condTiredPlayerOnPitch"), value: "TIRED_PLAYER_ON_PITCH" },
  { label: i18n.t("automation.condBookedPlayerOnPitch"), value: "BOOKED_PLAYER_ON_PITCH" },
  { label: i18n.t("automation.condHasSubsLeft"), value: "HAS_SUBS_LEFT" },
  { label: i18n.t("automation.condLosingPossession"), value: "LOSING_POSSESSION" },
];

const ACTION_OPTS = (): { label: string; value: ActionKind }[] => [
  { label: i18n.t("automation.actionSub"), value: "SUB" },
  { label: i18n.t("automation.actionTactics"), value: "TACTICS" },
  { label: i18n.t("automation.actionSetTaker"), value: "SET_TAKER" },
  { label: i18n.t("automation.actionSwapSlots"), value: "SWAP_SLOTS" },
  { label: i18n.t("automation.actionStopAutomation"), value: "STOP_AUTOMATION" },
  { label: i18n.t("automation.actionHalftimeReady"), value: "HALFTIME_READY" },
];

const OUT_SELECT_OPTS = (): { label: string; value: OutSelect }[] => [
  { label: i18n.t("automation.outSelectPlayer"), value: "PLAYER" },
  { label: i18n.t("automation.outSelectSlot"), value: "SLOT" },
  { label: i18n.t("automation.outSelectMostTired"), value: "MOST_TIRED" },
  { label: i18n.t("automation.outSelectBooked"), value: "BOOKED" },
];

const IN_SELECT_OPTS = (): { label: string; value: InSelect }[] => [
  { label: i18n.t("automation.inSelectPlayer"), value: "PLAYER" },
  { label: i18n.t("automation.inSelectBestForRole"), value: "BEST_FOR_ROLE" },
];

const MINUTE_OPTS = Array.from({ length: 90 }, (_, i) => ({ label: `${i + 1}'`, value: i + 1 }));

function triggerLabel(kind: TriggerKind): string {
  return TRIGGER_OPTS().find((o) => o.value === kind)?.label ?? kind;
}
function conditionLabel(cond: Condition): string {
  return CONDITION_OPTS().find((o) => o.value === cond)?.label ?? cond;
}
function actionLabel(kind: ActionKind): string {
  return ACTION_OPTS().find((o) => o.value === kind)?.label ?? kind;
}

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

function newAction(): Action {
  return { kind: "SUB" };
}

/** One-line plain-language summary shown in a rule's always-visible header,
 *  so a manager can scan several rules without opening each one. */
function ruleSummary(rule: Rule, t: TFunction): string {
  let trigger = triggerLabel(rule.trigger.kind);
  if (rule.trigger.kind === "MINUTE") trigger = `${trigger} ${rule.trigger.minute}'`;
  if (rule.fromMinute !== undefined || rule.toMinute !== undefined) {
    trigger += ` (${rule.fromMinute ?? 1}'–${rule.toMinute ?? 90}')`;
  }
  const actionsText = rule.actions.length > 0 ? rule.actions.map((a) => actionLabel(a.kind)).join(" + ") : t("automation.noActionsYet");
  if (rule.conditions.length === 0) {
    return t("automation.summaryNoCondition", { trigger, actions: actionsText });
  }
  const conditionText = rule.conditions.map(conditionLabel).join(", ");
  return t("automation.summaryWithCondition", { trigger, condition: conditionText, actions: actionsText });
}

/** Grouped player-picker options: this club's XI/bench for the rule's
 *  formation first, everyone else in the squad after — so a rule built while
 *  editing naturally favors the lineup it will actually face, without
 *  blocking a pick outside it (lineups change; a hard block would be wrong). */
function groupedPlayerOptions(squad: PlayerView[], primaryIds: Set<number>, primaryLabel: string, restLabel: string) {
  const label = (pl: PlayerView) => {
    const nat = (pl as unknown as { naturalPosition?: string }).naturalPosition;
    return `${pl.displayName ?? pl.name} · ${positionLabel(nat)} · ${pl.overall}`;
  };
  const primary = squad.filter((pl) => primaryIds.has(pl.id));
  const rest = squad.filter((pl) => !primaryIds.has(pl.id));
  const groups = [];
  if (primary.length > 0) groups.push({ label: primaryLabel, items: primary.map((pl) => ({ label: label(pl), value: pl.id })) });
  if (rest.length > 0) groups.push({ label: restLabel, items: rest.map((pl) => ({ label: label(pl), value: pl.id })) });
  return groups;
}

/** Slot-picker options from the rule's formation, backend-labelled (e.g. "Right Back"). */
function slotOptions(lineup: LineupView | null): { label: string; value: number }[] {
  return (lineup?.slots ?? []).map((s) => ({ label: `${s.index + 1}. ${s.label}`, value: s.index }));
}

/** Client-side mirror of the backend action validation; a non-null message blocks saving. */
function actionIssue(triggerKind: TriggerKind, a: Action): string | null {
  if (a.kind === "SUB") {
    const outSelect = a.outSelect ?? "PLAYER";
    const inSelect = a.inSelect ?? "PLAYER";
    if (outSelect === "PLAYER" && !a.outPlayerId) return i18n.t("automation.issuePickOut");
    if (outSelect === "SLOT" && a.outSlotIndex === undefined) return i18n.t("automation.issuePickSlot");
    if (inSelect === "PLAYER" && !a.inPlayerId) return i18n.t("automation.issuePickIn");
    if (outSelect === "PLAYER" && inSelect === "PLAYER" && a.outPlayerId === a.inPlayerId) return i18n.t("automation.issueDifferentPlayers");
    return null;
  }
  if (a.kind === "TACTICS") {
    const changed = a.formation !== undefined || a.style !== undefined || a.pressing !== undefined || a.direction !== undefined;
    if (!changed) return i18n.t("automation.issueChooseTactic");
    if (a.formation !== undefined && triggerKind !== "HALF_TIME") return i18n.t("automation.issueFormationHalftime");
    return null;
  }
  if (a.kind === "SET_TAKER") return a.takerPlayerId ? null : i18n.t("automation.issuePickTaker");
  if (a.kind === "SWAP_SLOTS") {
    if (!a.swapPlayerAId || !a.swapPlayerBId) return i18n.t("automation.issuePickSwapPlayers");
    if (a.swapPlayerAId === a.swapPlayerBId) return i18n.t("automation.issueDifferentPlayers");
    return null;
  }
  return null; // STOP_AUTOMATION / HALFTIME_READY require no fields.
}

/** First blocking issue across a whole rule (its guard, or any of its actions). */
/** The rule's own guard issue — shown once at the bottom of the rule body.
 *  Per-action issues are shown inline on each ActionCard instead, so a rule
 *  with several actions never repeats the same message twice. */
function ruleGuardIssue(rule: Rule): string | null {
  if (rule.trigger.kind === "MINUTE" && (rule.fromMinute !== undefined || rule.toMinute !== undefined)) return i18n.t("automation.issueGuardOnMinute");
  if (rule.fromMinute !== undefined && rule.toMinute !== undefined && rule.fromMinute > rule.toMinute) return i18n.t("automation.issueGuardOrder");
  return null;
}

/** Every blocking issue for a rule (its guard, plus each of its actions) —
 *  used only to gate the overall Save button, never rendered verbatim. */
function ruleIssues(rule: Rule): string[] {
  const guard = ruleGuardIssue(rule);
  const actionIssues = rule.actions.map((a) => actionIssue(rule.trigger.kind, a)).filter((msg): msg is string => msg !== null);
  return guard ? [guard, ...actionIssues] : actionIssues;
}

function SectionLabel({ children }: { children: string }) {
  return <div className="aut-section-label">{children}</div>;
}

function ActionCard({
  action,
  index,
  triggerKind,
  outOptions,
  inOptions,
  slotOpts,
  formations,
  warnOutOfGroup,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  canRemove,
}: {
  action: Action;
  index: number;
  triggerKind: TriggerKind;
  outOptions: ReturnType<typeof groupedPlayerOptions>;
  inOptions: ReturnType<typeof groupedPlayerOptions>;
  slotOpts: { label: string; value: number }[];
  formations: TacticOption[];
  warnOutOfGroup: (id: number | undefined, group: "starters" | "bench") => boolean;
  onChange: (next: Action) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
}) {
  const { t } = useTranslation();
  const patch = (p: Partial<Action>) => onChange({ ...action, ...p });
  const issue = actionIssue(triggerKind, action);

  return (
    <div className="aut-action-card">
      <div className="aut-action-header">
        <span className="aut-action-badge">{index + 1}</span>
        <Dropdown
          value={action.kind}
          onChange={(e) => onChange({ kind: e.value })}
          options={ACTION_OPTS()}
          style={{ minWidth: 190 }}
          aria-label={t("automation.actionAria")}
        />
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button className="btn ghost sm" onClick={onMoveUp} disabled={!canMoveUp} aria-label={t("automation.moveActionUpAria")} title={t("automation.moveUp")}>
            <ArrowUp size={13} />
          </button>
          <button className="btn ghost sm" onClick={onMoveDown} disabled={!canMoveDown} aria-label={t("automation.moveActionDownAria")} title={t("automation.moveDown")}>
            <ArrowDown size={13} />
          </button>
          <button className="btn ghost danger sm" onClick={onRemove} disabled={!canRemove} aria-label={t("automation.removeActionAria")} title={!canRemove ? t("automation.lastActionHint") : t("automation.remove")}>
            {t("automation.remove")}
          </button>
        </div>
      </div>

      {action.kind === "SUB" && (
        <div className="aut-action-fields" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div className="aut-row">
            <span className="aut-hint">{t("automation.outLabel")}</span>
            <Dropdown
              value={action.outSelect ?? "PLAYER"}
              onChange={(e) => patch({ outSelect: e.value, outPlayerId: undefined, outSlotIndex: undefined })}
              options={OUT_SELECT_OPTS()}
              style={{ minWidth: 170 }}
              aria-label={t("automation.outSelectAria")}
            />
            {(action.outSelect ?? "PLAYER") === "PLAYER" && (
              <Dropdown
                value={action.outPlayerId ?? null}
                onChange={(e) => patch(e.value === null ? { outPlayerId: undefined } : { outPlayerId: e.value })}
                options={outOptions}
                optionLabel="label"
                optionGroupLabel="label"
                optionGroupChildren="items"
                placeholder={t("automation.offPlaceholder")}
                showClear
                filter
                style={{ flex: 1, minWidth: 220 }}
              />
            )}
            {action.outSelect === "SLOT" && (
              <Dropdown
                value={action.outSlotIndex ?? null}
                onChange={(e) => patch(e.value === null ? { outSlotIndex: undefined } : { outSlotIndex: e.value })}
                options={slotOpts}
                placeholder={t("automation.slotPlaceholder")}
                showClear
                style={{ flex: 1, minWidth: 220 }}
              />
            )}
            {warnOutOfGroup(action.outPlayerId, "starters") && (action.outSelect ?? "PLAYER") === "PLAYER" && (
              <span className="aut-warning"><TriangleAlert size={13} /> {t("automation.warningNotInXI")}</span>
            )}
          </div>
          <div className="aut-row">
            <span className="aut-hint">{t("automation.inLabel")}</span>
            <Dropdown
              value={action.inSelect ?? "PLAYER"}
              onChange={(e) => patch({ inSelect: e.value, inPlayerId: undefined })}
              options={IN_SELECT_OPTS()}
              style={{ minWidth: 170 }}
              aria-label={t("automation.inSelectAria")}
            />
            {(action.inSelect ?? "PLAYER") === "PLAYER" && (
              <Dropdown
                value={action.inPlayerId ?? null}
                onChange={(e) => patch(e.value === null ? { inPlayerId: undefined } : { inPlayerId: e.value })}
                options={inOptions}
                optionLabel="label"
                optionGroupLabel="label"
                optionGroupChildren="items"
                placeholder={t("automation.onPlaceholder")}
                showClear
                filter
                style={{ flex: 1, minWidth: 220 }}
              />
            )}
            {warnOutOfGroup(action.inPlayerId, "bench") && (action.inSelect ?? "PLAYER") === "PLAYER" && (
              <span className="aut-warning"><TriangleAlert size={13} /> {t("automation.warningNotOnBench")}</span>
            )}
          </div>
        </div>
      )}

      {action.kind === "TACTICS" && (
        <div className="aut-action-fields">
          {triggerKind === "HALF_TIME" && (
            <Dropdown
              value={action.formation ?? null}
              onChange={(e) => patch(e.value === null ? { formation: undefined } : { formation: e.value })}
              options={[...withUnchanged(formations)]}
              placeholder={t("automation.formationPlaceholder")}
              style={{ minWidth: 160, flex: 1 }}
              aria-label={t("automation.formationAria")}
            />
          )}
          <Dropdown
            value={action.style ?? null}
            onChange={(e) => patch(e.value === null ? { style: undefined } : { style: e.value })}
            options={[...withUnchanged(styleOptions())]}
            placeholder={t("automation.stylePlaceholder")}
            style={{ minWidth: 150, flex: 1 }}
            aria-label={t("automation.styleAria")}
            itemTemplate={automationItemTemplate}
          />
          <Dropdown
            value={action.pressing ?? null}
            onChange={(e) => patch(e.value === null ? { pressing: undefined } : { pressing: e.value })}
            options={[...withUnchanged(pressingOptions())]}
            placeholder={t("automation.pressingPlaceholder")}
            style={{ minWidth: 140, flex: 1 }}
            aria-label={t("automation.pressingAria")}
            itemTemplate={automationItemTemplate}
          />
          <Dropdown
            value={action.direction ?? null}
            onChange={(e) => patch(e.value === null ? { direction: undefined } : { direction: e.value })}
            options={[...withUnchanged(directionOptions())]}
            placeholder={t("automation.directionPlaceholder")}
            style={{ minWidth: 170, flex: 1 }}
            aria-label={t("automation.directionAria")}
            itemTemplate={automationItemTemplate}
          />
        </div>
      )}

      {action.kind === "SET_TAKER" && (
        <div className="aut-action-fields">
          <Dropdown
            value={action.takerPlayerId ?? null}
            onChange={(e) => patch(e.value === null ? { takerPlayerId: undefined } : { takerPlayerId: e.value })}
            options={outOptions}
            optionLabel="label"
            optionGroupLabel="label"
            optionGroupChildren="items"
            placeholder={t("automation.takerPlaceholder")}
            showClear
            filter
            style={{ flex: 1, minWidth: 240 }}
          />
          {warnOutOfGroup(action.takerPlayerId, "starters") && (
            <span className="aut-warning"><TriangleAlert size={13} /> {t("automation.warningNotInXI")}</span>
          )}
          <span className="aut-hint">{t("automation.setTakerHint")}</span>
        </div>
      )}

      {action.kind === "SWAP_SLOTS" && (
        <div className="aut-action-fields">
          <Dropdown
            value={action.swapPlayerAId ?? null}
            onChange={(e) => patch(e.value === null ? { swapPlayerAId: undefined } : { swapPlayerAId: e.value })}
            options={outOptions}
            optionLabel="label"
            optionGroupLabel="label"
            optionGroupChildren="items"
            placeholder={t("automation.swapAPlaceholder")}
            showClear
            filter
            style={{ flex: 1, minWidth: 220 }}
          />
          <span className="aut-hint">⇄</span>
          <Dropdown
            value={action.swapPlayerBId ?? null}
            onChange={(e) => patch(e.value === null ? { swapPlayerBId: undefined } : { swapPlayerBId: e.value })}
            options={outOptions}
            optionLabel="label"
            optionGroupLabel="label"
            optionGroupChildren="items"
            placeholder={t("automation.swapBPlaceholder")}
            showClear
            filter
            style={{ flex: 1, minWidth: 220 }}
          />
        </div>
      )}

      {action.kind === "STOP_AUTOMATION" && <div className="aut-action-fields"><span className="aut-hint">{t("automation.stopAutomationHint")}</span></div>}
      {action.kind === "HALFTIME_READY" && <div className="aut-action-fields"><span className="aut-hint">{t("automation.halftimeReadyHint")}</span></div>}

      {issue && <div className="aut-warning" style={{ paddingLeft: 26 }}><TriangleAlert size={13} /> {issue}</div>}
    </div>
  );
}

function RuleCard({
  rule,
  index,
  squad,
  lineup,
  formations,
  expanded,
  onToggleExpanded,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  maxFiresCap,
  maxActionsPerRule,
}: {
  rule: Rule;
  index: number;
  squad: PlayerView[];
  lineup: LineupView | null;
  formations: TacticOption[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (next: Rule) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  maxFiresCap: number;
  maxActionsPerRule: number;
}) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(() => rule.fromMinute !== undefined || rule.toMinute !== undefined || rule.maxFires !== undefined);
  const starterIds = useMemo(() => new Set((lineup?.starters ?? []).filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.id)), [lineup]);
  const benchIds = useMemo(() => new Set((lineup?.subs ?? []).filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.id)), [lineup]);
  const outOptions = useMemo(() => groupedPlayerOptions(squad, starterIds, t("automation.outGroupXI"), t("automation.outGroupElsewhere")), [squad, starterIds, t]);
  const inOptions = useMemo(() => groupedPlayerOptions(squad, benchIds, t("automation.inGroupBench"), t("automation.inGroupElsewhere")), [squad, benchIds, t]);
  const slotOpts = useMemo(() => slotOptions(lineup), [lineup]);
  const guardIssue = ruleGuardIssue(rule);

  const warnOutOfGroup = (id: number | undefined, group: "starters" | "bench") =>
    id !== undefined && lineup !== null && !(group === "starters" ? starterIds : benchIds).has(id);

  const patchAction = (actionIndex: number, next: Action) =>
    onChange({ ...rule, actions: rule.actions.map((a, i) => (i === actionIndex ? next : a)) });
  const moveAction = (actionIndex: number, delta: number) => {
    const next = rule.actions.slice();
    const target = actionIndex + delta;
    if (target < 0 || target >= next.length) return;
    [next[actionIndex], next[target]] = [next[target], next[actionIndex]];
    onChange({ ...rule, actions: next });
  };

  const stopIndex = rule.actions.findIndex((a) => a.kind === "STOP_AUTOMATION");
  const hasDeadActions = stopIndex !== -1 && stopIndex < rule.actions.length - 1;

  return (
    <div className="aut-rule-card">
      <div
        className="aut-rule-header"
        role="button"
        tabIndex={0}
        onClick={onToggleExpanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpanded();
          }
        }}
        aria-expanded={expanded}
      >
        <span className="aut-rule-badge">{index + 1}</span>
        <ChevronDown size={15} className={`aut-rule-chevron${expanded ? "" : " collapsed"}`} />
        <span className="aut-rule-summary">{ruleSummary(rule, t)}</span>
        <div className="aut-rule-controls" onClick={(e) => e.stopPropagation()}>
          <button className="btn ghost sm" onClick={onMoveUp} disabled={!canMoveUp} aria-label={t("automation.moveUpAria")} title={t("automation.moveUp")}>
            <ArrowUp size={13} />
          </button>
          <button className="btn ghost sm" onClick={onMoveDown} disabled={!canMoveDown} aria-label={t("automation.moveDownAria")} title={t("automation.moveDown")}>
            <ArrowDown size={13} />
          </button>
          <button className="btn ghost danger sm" onClick={onRemove} aria-label={t("automation.removeRuleAria")}>
            {t("automation.remove")}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="aut-rule-body">
          <div className="aut-section aut-section-when">
            <SectionLabel>{t("automation.when")}</SectionLabel>
            <div className="aut-row">
              <Dropdown
                value={rule.trigger.kind}
                onChange={(e) => {
                  const kind = e.value === "MINUTE" ? { kind: e.value, minute: rule.trigger.minute ?? 60 } : { kind: e.value };
                  // Formation changes are only legal at half-time; drop a stale
                  // formation field from any TACTICS action when the trigger
                  // moves away from it. A minute window guard is meaningless on
                  // MINUTE (which already pins one exact minute), so drop it too.
                  const actions = kind.kind !== "HALF_TIME"
                    ? rule.actions.map((a) => (a.kind === "TACTICS" ? { ...a, formation: undefined } : a))
                    : rule.actions;
                  const guards = kind.kind === "MINUTE" ? { fromMinute: undefined, toMinute: undefined } : {};
                  onChange({ ...rule, trigger: kind, actions, ...guards });
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

            {!advancedOpen ? (
              <button type="button" className="aut-advanced-toggle" onClick={() => setAdvancedOpen(true)}>
                <SlidersHorizontal size={12} /> {t("automation.advancedOptions")}
              </button>
            ) : (
              <div className="aut-row">
                {rule.trigger.kind !== "MINUTE" && (
                  <>
                    <span className="aut-hint">{t("automation.guardLabel")}</span>
                    <InputNumber
                      value={rule.fromMinute ?? null}
                      onValueChange={(e) => onChange({ ...rule, fromMinute: e.value ?? undefined })}
                      min={1}
                      max={90}
                      placeholder={t("automation.fromMinutePlaceholder")}
                      showButtons={false}
                      style={{ width: 90 }}
                      inputStyle={{ width: 90 }}
                      aria-label={t("automation.fromMinuteAria")}
                    />
                    <span className="aut-hint">–</span>
                    <InputNumber
                      value={rule.toMinute ?? null}
                      onValueChange={(e) => onChange({ ...rule, toMinute: e.value ?? undefined })}
                      min={1}
                      max={90}
                      placeholder={t("automation.toMinutePlaceholder")}
                      showButtons={false}
                      style={{ width: 90 }}
                      inputStyle={{ width: 90 }}
                      aria-label={t("automation.toMinuteAria")}
                    />
                  </>
                )}
                <span style={{ marginLeft: rule.trigger.kind === "MINUTE" ? 0 : "auto", display: "flex", gap: 6, alignItems: "center" }}>
                  <span className="aut-hint">{t("automation.maxFiresLabel")}</span>
                  <InputNumber
                    value={rule.maxFires ?? 1}
                    onValueChange={(e) => onChange({ ...rule, maxFires: e.value && e.value > 1 ? e.value : undefined })}
                    min={1}
                    max={maxFiresCap}
                    showButtons
                    buttonLayout="horizontal"
                    decrementButtonClassName="btn-xs"
                    incrementButtonClassName="btn-xs"
                    style={{ width: 90 }}
                    inputStyle={{ width: 46, textAlign: "center" }}
                    aria-label={t("automation.maxFiresAria")}
                  />
                </span>
              </div>
            )}
          </div>

          <div className="aut-section aut-section-if">
            <SectionLabel>{t("automation.if")}</SectionLabel>
            <MultiSelect
              value={rule.conditions}
              options={CONDITION_OPTS()}
              onChange={(e) => onChange({ ...rule, conditions: e.value })}
              optionLabel="label"
              optionValue="value"
              placeholder={t("automation.condAny")}
              display="chip"
              style={{ minWidth: 260 }}
              aria-label={t("automation.conditionAria")}
            />
          </div>

          <div className="aut-section aut-section-then">
            <SectionLabel>{t("automation.then")}</SectionLabel>
            <div className="aut-action-list">
              {rule.actions.map((action, i) => (
                <ActionCard
                  key={i}
                  action={action}
                  index={i}
                  triggerKind={rule.trigger.kind}
                  outOptions={outOptions}
                  inOptions={inOptions}
                  slotOpts={slotOpts}
                  formations={formations}
                  warnOutOfGroup={warnOutOfGroup}
                  onChange={(next) => patchAction(i, next)}
                  onRemove={() => onChange({ ...rule, actions: rule.actions.filter((_, idx) => idx !== i) })}
                  onMoveUp={() => moveAction(i, -1)}
                  onMoveDown={() => moveAction(i, 1)}
                  canMoveUp={i > 0}
                  canMoveDown={i < rule.actions.length - 1}
                  canRemove={rule.actions.length > 1}
                />
              ))}
            </div>
            {hasDeadActions && (
              <div className="aut-warning"><TriangleAlert size={13} /> {t("automation.issueActionsAfterStop")}</div>
            )}
            <button
              className="btn ghost sm"
              style={{ alignSelf: "flex-start" }}
              disabled={rule.actions.length >= maxActionsPerRule}
              onClick={() => onChange({ ...rule, actions: [...rule.actions, newAction()] })}
            >
              + {t("automation.addAction", { count: rule.actions.length, max: maxActionsPerRule })}
            </button>
          </div>

          {guardIssue && <div className="aut-warning"><TriangleAlert size={13} /> {guardIssue}</div>}
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
  maxFiresCap,
  maxActionsPerRule,
  onChange,
  onRequestRemove,
  customTooltips,
}: {
  preset: Preset;
  squad: PlayerView[];
  formations: TacticOption[];
  maxRules: number;
  maxFiresCap: number;
  maxActionsPerRule: number;
  onChange: (next: Preset) => void;
  onRequestRemove: () => void;
  customTooltips: boolean;
}) {
  const { t } = useTranslation();
  const [lineup, setLineup] = useState<LineupView | null>(null);
  const [collapsedRuleIds, setCollapsedRuleIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    setLineup(null);
    void api
      .getLineup(false, preset.formationId)
      .then((res) => { if (!cancelled) setLineup(res); })
      .catch(() => { if (!cancelled) setLineup(null); });
    return () => {
      cancelled = true;
    };
  }, [preset.formationId]);

  const moveRule = (index: number, delta: number) => {
    const next = preset.rules.slice();
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...preset, rules: next });
  };
  const toggleExpanded = (ruleId: string) => {
    setCollapsedRuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

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
        <button className="btn ghost danger sm" onClick={onRequestRemove}>
          {t("automation.deleteRuleSet")}
        </button>
      </div>

      {preset.rules.length === 0 && (
        <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginBottom: 8 }}>{t("automation.noRulesYet")}</div>
      )}

      {preset.rules.map((rule, index) => (
        <RuleCard
          formations={formations}
          key={rule.id}
          rule={rule}
          index={index}
          squad={squad}
          lineup={lineup}
          maxFiresCap={maxFiresCap}
          maxActionsPerRule={maxActionsPerRule}
          expanded={!collapsedRuleIds.has(rule.id)}
          onToggleExpanded={() => toggleExpanded(rule.id)}
          onChange={(next) => onChange({ ...preset, rules: preset.rules.map((r) => (r.id === rule.id ? next : r)) })}
          onRemove={() => onChange({ ...preset, rules: preset.rules.filter((r) => r.id !== rule.id) })}
          onMoveUp={() => moveRule(index, -1)}
          onMoveDown={() => moveRule(index, 1)}
          canMoveUp={index > 0}
          canMoveDown={index < preset.rules.length - 1}
        />
      ))}

      <button
        className="btn ghost sm"
        disabled={preset.rules.length >= maxRules}
        onClick={() =>
          onChange({
            ...preset,
            rules: [...preset.rules, { id: uid(), trigger: { kind: "MINUTE", minute: 60 }, conditions: [], actions: [newAction()] }],
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
  const [confirmRemove, setConfirmRemove] = useState<Preset | null>(null);
  // §16.1: formation options come from the authenticated snapshot, never a
  // local table. Caps/vocabularies are likewise backend-owned (automationConfig).
  const formations = useMemo(() => formationsFromSnapshot(snap?.formationOptions), [snap?.formationOptions]);
  const formationName = (id: number) => labelOf(formations, id);
  const caps = snap?.automationConfig;

  useEffect(() => {
    void api
      .getAutomation()
      .then((res) => {
        // Legacy rows may carry a null scope, a pre-list singular `condition`,
        // or a pre-multi-action singular `action` — the server's
        // parseStoredPresets already migrated all three by the time this
        // response is built, so no client-side lift is needed here.
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
    () => presets.flatMap((p) => p.rules.flatMap(ruleIssues)),
    [presets]
  );
  const canSave = useMemo(() => loaded && Boolean(caps) && issues.length === 0 && dirty, [loaded, caps, issues, dirty]);

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

  if (!loaded || !caps) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="card-title"><Zap size={17} /> {t("squad.automationTitle")}</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem" }}>{t("automation.loading")}</div>
      </div>
    );
  }

  const quotaBlocked = !isPro && presets.length >= caps.maxPresetsRegular;
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
            maxRules={caps.maxRulesPerPreset}
            maxFiresCap={caps.maxFiresCap}
            maxActionsPerRule={caps.maxActionsPerRule}
            onChange={(next) => mutate((prev) => prev.map((p) => (p.id === current.id ? next : p)))}
            onRequestRemove={() => setConfirmRemove(current)}
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
                    maxRules={caps.maxRulesPerPreset}
                    maxFiresCap={caps.maxFiresCap}
                    maxActionsPerRule={caps.maxActionsPerRule}
                    onChange={(next) => mutate((prev) => prev.map((x) => (x.id === p.id ? next : x)))}
                    onRequestRemove={() => setConfirmRemove(p)}
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

      <Dialog header={t("automation.confirmDeleteTitle")} visible={confirmRemove !== null} onHide={() => setConfirmRemove(null)} dismissableMask style={{ width: 420 }}>
        {confirmRemove && (
          <>
            <div style={{ color: "var(--text-2)", lineHeight: 1.5 }}>
              {t("automation.confirmDeleteMessage", { name: confirmRemove.name || t("automation.unnamed") })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setConfirmRemove(null)}>{t("common.cancel")}</button>
              <button
                className="btn red"
                style={{ flex: 1 }}
                onClick={() => {
                  const target = confirmRemove;
                  mutate((prev) => prev.filter((x) => x.id !== target.id));
                  setConfirmRemove(null);
                }}
              >
                {t("common.confirm")}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
