import { z } from "zod";
import { AUTOMATION_CONFIG, MP_CONFIG } from "../config";
import type {
  AutomationAction,
  AutomationCondition,
  AutomationInSelect,
  AutomationOutSelect,
  AutomationPreset,
  AutomationRule,
  AutomationTriggerKind,
  Club,
  LiveMatchState,
  Player,
  World,
} from "./types";
import { applyLiveFormationChange, applyLiveTacticsUpdate, markHalftimeReady, performLiveSub, resolveDeployedSlot } from "./match";
import { isHalftime, isPregame } from "./match";
import { AUTOMATION_REASON, AUTOMATION_SUBTYPES, DIRECTION_NAMES, EVENT_CODES, PRESSING_NAMES, STYLE_NAMES } from "./constants";
import { FORMATIONS } from "./formations";
import { pickInjuryReplacement } from "./matchSim";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";

// Real tactic ranges (backend/src/game/constants.ts); presets may only ever
// target values a club tactic could legitimately hold.
const MAX_FORMATION = FORMATIONS.length - 1;
const MAX_STYLE = STYLE_NAMES.length - 1;
const MAX_PRESSING = PRESSING_NAMES.length - 1;
const MAX_DIRECTION = DIRECTION_NAMES.length - 1;

// ---------------------------------------------------------------------------
// Strict schemas (fresh saves via PUT /mp/automation)
// ---------------------------------------------------------------------------

export const triggerSchema = z
  .object({
    kind: z.enum(AUTOMATION_CONFIG.allowedEvents as unknown as [string, ...string[]]),
    minute: z.number().int().min(1).max(90).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "MINUTE" && v.minute === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minute is required for MINUTE trigger" });
    if (v.kind !== "MINUTE" && v.minute !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minute only allowed for MINUTE trigger" });
  });

export const actionSchema = z
  .object({
    kind: z.enum(AUTOMATION_CONFIG.allowedActions as unknown as [string, ...string[]]),
    // SUB
    outPlayerId: z.number().int().optional(),
    inPlayerId: z.number().int().optional(),
    outSelect: z.enum(AUTOMATION_CONFIG.allowedOutSelects as unknown as [string, ...string[]]).optional(),
    inSelect: z.enum(AUTOMATION_CONFIG.allowedInSelects as unknown as [string, ...string[]]).optional(),
    outSlotIndex: z.number().int().min(0).max(10).optional(),
    // TACTICS
    formation: z.number().int().min(0).max(MAX_FORMATION).optional(),
    style: z.number().int().min(0).max(MAX_STYLE).optional(),
    pressing: z.number().int().min(0).max(MAX_PRESSING).optional(),
    direction: z.number().int().min(0).max(MAX_DIRECTION).optional(),
    // SWAP_SLOTS
    swapPlayerAId: z.number().int().optional(),
    swapPlayerBId: z.number().int().optional(),
    // SET_TAKER
    takerPlayerId: z.number().int().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "SUB") {
      const outSelect = (v.outSelect ?? "PLAYER") as AutomationOutSelect;
      const inSelect = (v.inSelect ?? "PLAYER") as AutomationInSelect;
      if (outSelect === "PLAYER" && v.outPlayerId === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SUB requires outPlayerId when outSelect is PLAYER" });
      if (outSelect === "SLOT" && v.outSlotIndex === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SUB requires outSlotIndex when outSelect is SLOT" });
      if (inSelect === "PLAYER" && v.inPlayerId === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SUB requires inPlayerId when inSelect is PLAYER" });
      if (outSelect === "PLAYER" && inSelect === "PLAYER" && v.outPlayerId !== undefined && v.outPlayerId === v.inPlayerId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The outgoing and incoming player must be different" });
      }
    }
    if (v.kind === "TACTICS" && v.formation === undefined && v.style === undefined && v.pressing === undefined && v.direction === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TACTICS requires at least one field" });
    }
    if (v.kind === "SET_TAKER" && v.takerPlayerId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SET_TAKER requires takerPlayerId" });
    }
    if (v.kind === "SWAP_SLOTS") {
      if (v.swapPlayerAId === undefined || v.swapPlayerBId === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SWAP_SLOTS requires swapPlayerAId and swapPlayerBId" });
      } else if (v.swapPlayerAId === v.swapPlayerBId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SWAP_SLOTS requires two different players" });
      }
    }
  });

export const ruleSchema = z
  .object({
    id: z.string().min(1).max(64),
    trigger: triggerSchema,
    /** ANDed conditions. Empty = unconditional (legacy "ANY"). */
    conditions: z.array(z.enum(AUTOMATION_CONFIG.allowedConditions as unknown as [string, ...string[]])).max(8).default([]),
    fromMinute: z.number().int().min(1).max(90).optional(),
    toMinute: z.number().int().min(1).max(90).optional(),
    maxFires: z.number().int().min(1).max(AUTOMATION_CONFIG.maxFiresCap).optional(),
    /** Every action here runs, in order, when the rule fires. At least one. */
    actions: z.array(actionSchema).min(1).max(AUTOMATION_CONFIG.maxActionsPerRule),
  })
  .superRefine((v, ctx) => {
    for (const action of v.actions) {
      if (action.kind === "TACTICS" && action.formation !== undefined && v.trigger.kind !== "HALF_TIME") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A formation change may only trigger at half-time" });
      }
    }
    if (v.trigger.kind === "MINUTE" && (v.fromMinute !== undefined || v.toMinute !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A minute window is redundant on a MINUTE trigger" });
    }
    if (v.fromMinute !== undefined && v.toMinute !== undefined && v.fromMinute > v.toMinute) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fromMinute must not be after toMinute" });
    }
  });

// Presets are strictly bound to one formation ("per-tactic" model).
export const presetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  formationId: z.number().int().min(0).max(MAX_FORMATION),
  enabled: z.boolean(),
  rules: z.array(ruleSchema).max(AUTOMATION_CONFIG.maxRulesPerPreset),
});

export const presetsSchema = z.array(presetSchema);

/** Rejects an oversized stored payload before it ever reaches the DB — a
 *  structural abuse/storage guard (AUTOMATION_CONFIG.maxAutomationPayloadBytes),
 *  not a balance limit. Rule count is already capped by presetsSchema. */
export function validatePayloadSize(presets: AutomationPreset[]): string | null {
  const bytes = Buffer.byteLength(JSON.stringify(presets), "utf8");
  if (bytes > AUTOMATION_CONFIG.maxAutomationPayloadBytes) {
    return `Automation presets are too large (${bytes} bytes, max ${AUTOMATION_CONFIG.maxAutomationPayloadBytes})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lenient legacy migration
// ---------------------------------------------------------------------------

/**
 * Legacy rows (pre per-tactic migration, and pre-conditions-list migration)
 * allowed `formationId: null` ("any formation"), looser tactic ranges on
 * TACTICS actions, and a single `condition` field instead of `conditions[]`.
 * Stored presets are parsed leniently, then normalized:
 * - null/out-of-range preset scopes bind to the club's current saved formation;
 * - impossible TACTICS action values are dropped, and rules left with no
 *   possible effect are removed;
 * - a legacy singular `condition` lifts into a one-element `conditions` array;
 * - an out-of-range minute-window guard, or one attached to a MINUTE trigger,
 *   is stripped rather than rejecting the whole rule;
 * - rule count is truncated to AUTOMATION_CONFIG.maxRulesPerPreset (a
 *   structural cap, never expected to be hit through normal use — see AGENTS.md
 *   "never hard-code tunables"/config.ts comment on maxRulesPerPreset).
 * The result always satisfies the strict presetSchema, so any later PUT round-trips cleanly.
 */
const storedActionSchema = z.object({
  kind: z.enum(AUTOMATION_CONFIG.allowedActions as unknown as [string, ...string[]]),
  outPlayerId: z.number().int().optional(),
  inPlayerId: z.number().int().optional(),
  outSelect: z.string().optional(),
  inSelect: z.string().optional(),
  outSlotIndex: z.number().int().optional(),
  // Legacy bounds were looser than the real tactic ranges; sanitize below.
  // Formation's loose bound is the real catalog max: with 23 formations the
  // highest id (22) exceeds the old fixed 20 cap, which would have dropped
  // legitimate stored presets as corrupt.
  formation: z.number().int().min(0).max(MAX_FORMATION).optional(),
  style: z.number().int().min(0).max(20).optional(),
  pressing: z.number().int().min(0).max(20).optional(),
  direction: z.number().int().min(0).max(20).optional(),
  swapPlayerAId: z.number().int().optional(),
  swapPlayerBId: z.number().int().optional(),
  takerPlayerId: z.number().int().optional(),
});

const storedRuleSchema = z.object({
  id: z.string().min(1).max(64),
  trigger: triggerSchema,
  /** Legacy singular condition (pre-list migration). */
  condition: z.string().optional(),
  /** Current ANDed list. */
  conditions: z.array(z.string()).optional(),
  fromMinute: z.number().int().optional(),
  toMinute: z.number().int().optional(),
  maxFires: z.number().int().optional(),
  /** Legacy singular action (pre-multi-action migration). */
  action: storedActionSchema.optional(),
  /** Current ordered list — every action here runs when the rule fires. */
  actions: z.array(storedActionSchema).max(1000).optional(),
});

const storedPresetsSchema = z.array(
  z.object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(40),
    formationId: z.number().int().min(0).max(MAX_FORMATION).nullable(),
    enabled: z.boolean(),
    // Generous: excess is truncated below rather than rejecting the whole
    // preset outright. The strict schema re-caps to maxRulesPerPreset.
    rules: z.array(storedRuleSchema).max(1000),
  })
);

const VALID_CONDITIONS = new Set<string>(AUTOMATION_CONFIG.allowedConditions as unknown as string[]);

/** Lift a legacy singular `condition` or a stored `conditions[]` into the
 *  current shape, dropping any value the current vocabulary no longer knows. */
function normalizeConditions(r: { condition?: string; conditions?: string[] }): AutomationCondition[] {
  const raw = r.conditions && r.conditions.length > 0 ? r.conditions : r.condition ? [r.condition] : [];
  return raw.filter((c) => VALID_CONDITIONS.has(c)) as AutomationCondition[];
}

/**
 * Sanitize a stored TACTICS action, mirroring the strict schema: formation is
 * only legal when the rule fires at half-time (formation changes are locked
 * out during live play, so a stored minute/goal-triggered shape change could
 * never fire anyway). Out-of-range values are dropped; a rule left with no
 * surviving field is removed entirely.
 */
function sanitizeTacticsAction(action: AutomationAction, trigger: AutomationTriggerKind): AutomationAction | null {
  const clean: AutomationAction = { kind: "TACTICS" };
  if (action.formation !== undefined && action.formation >= 0 && action.formation <= MAX_FORMATION && trigger === "HALF_TIME") clean.formation = action.formation;
  if (action.style !== undefined && action.style >= 0 && action.style <= MAX_STYLE) clean.style = action.style;
  if (action.pressing !== undefined && action.pressing >= 0 && action.pressing <= MAX_PRESSING) clean.pressing = action.pressing;
  if (action.direction !== undefined && action.direction >= 0 && action.direction <= MAX_DIRECTION) clean.direction = action.direction;
  // A TACTICS rule with no surviving field can never do anything.
  return clean.formation !== undefined || clean.style !== undefined || clean.pressing !== undefined || clean.direction !== undefined ? clean : null;
}

/** Loose shape recovered from the lenient stored schema — `trigger`/`action`
 *  are cast to their real domain types (validated at runtime by the zod enums
 *  above); `condition`/`conditions` stay optional so both the legacy singular
 *  field and the current list survive the cast. */
type StoredPreset = {
  id: string;
  name: string;
  formationId: number | null;
  enabled: boolean;
  rules: {
    id: string;
    trigger: import("./types").AutomationTrigger;
    condition?: string;
    conditions?: string[];
    fromMinute?: number;
    toMinute?: number;
    maxFires?: number;
    /** Legacy singular action (pre-multi-action migration). */
    action?: AutomationAction;
    /** Current ordered list. */
    actions?: AutomationAction[];
  }[];
};

export function parseStoredPresets(raw: unknown, fallbackFormationId: number): AutomationPreset[] | null {
  const parsed = storedPresetsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const stored = parsed.data as unknown as StoredPreset[];
  const migrated: AutomationPreset[] = [];
  for (const p of stored) {
    const rules: AutomationRule[] = [];
    for (const r of p.rules) {
      // Legacy singular `action` lifts into a one-element list; a rule stored
      // before the multi-action migration always carried exactly one.
      const rawActions = r.actions && r.actions.length > 0 ? r.actions : r.action ? [r.action] : [];
      const actions: AutomationAction[] = [];
      for (const rawAction of rawActions) {
        if (rawAction.kind === "TACTICS") {
          const clean = sanitizeTacticsAction(rawAction, r.trigger.kind);
          if (clean) actions.push(clean);
          // A TACTICS action left with no surviving field is dropped, not kept.
        } else {
          actions.push(rawAction);
        }
      }
      // A rule with no surviving action can never do anything; drop it entirely.
      if (actions.length === 0) continue;
      const conditions = normalizeConditions(r);
      // Guards are meaningless on a MINUTE trigger (it already pins one exact
      // minute) and out-of-order bounds can never match anything; strip
      // rather than reject the rule.
      const isMinuteTrigger = r.trigger.kind === "MINUTE";
      let fromMinute = !isMinuteTrigger && r.fromMinute !== undefined && r.fromMinute >= 1 && r.fromMinute <= 90 ? r.fromMinute : undefined;
      let toMinute = !isMinuteTrigger && r.toMinute !== undefined && r.toMinute >= 1 && r.toMinute <= 90 ? r.toMinute : undefined;
      if (fromMinute !== undefined && toMinute !== undefined && fromMinute > toMinute) {
        fromMinute = undefined;
        toMinute = undefined;
      }
      const maxFires = r.maxFires !== undefined && r.maxFires >= 1 ? Math.min(r.maxFires, AUTOMATION_CONFIG.maxFiresCap) : undefined;
      rules.push({
        id: r.id,
        trigger: r.trigger,
        conditions,
        ...(fromMinute !== undefined ? { fromMinute } : {}),
        ...(toMinute !== undefined ? { toMinute } : {}),
        ...(maxFires !== undefined ? { maxFires } : {}),
        actions: actions.slice(0, AUTOMATION_CONFIG.maxActionsPerRule),
      });
    }
    migrated.push({
      ...p,
      formationId: p.formationId !== null && p.formationId >= 0 && p.formationId <= MAX_FORMATION ? p.formationId : fallbackFormationId,
      rules: rules.slice(0, AUTOMATION_CONFIG.maxRulesPerPreset),
    });
  }
  // Final strict validation guarantees every persisted preset satisfies presetSchema.
  const verified = presetsSchema.safeParse(migrated);
  return verified.success ? (verified.data as unknown as AutomationPreset[]) : null;
}

export function validatePresetQuotas(presets: AutomationPreset[], isPro: boolean): string | null {
  if (!isPro) {
    if (presets.length > AUTOMATION_CONFIG.maxPresetsRegular) return `Regular users may have at most ${AUTOMATION_CONFIG.maxPresetsRegular} preset`;
    return null;
  }
  // Pro: at most one per distinct formationId
  const byFormation = new Map<number | null, number>();
  for (const p of presets) {
    const key = p.formationId;
    byFormation.set(key, (byFormation.get(key) ?? 0) + 1);
  }
  for (const [, count] of byFormation) {
    if (count > AUTOMATION_CONFIG.maxPresetsPerFormationPro) return "Pro users may have at most one preset per formation";
  }
  // Also cap total presets to formations count * per-formation (generous)
  if (presets.length > 10) return "Too many presets";
  return null;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/** Score margin from the perspective of the owning side. */
function marginForSide(st: LiveMatchState, side: number): number {
  return side === 0 ? st.scores[0] - st.scores[1] : st.scores[1] - st.scores[0];
}

function onPitchIdsForSide(st: LiveMatchState, side: number): number[] {
  return side === 0 ? st.homeOn : st.awayOn;
}

function benchIdsForSide(st: LiveMatchState, side: number): number[] {
  return side === 0 ? st.homeSubs : st.awaySubs;
}

function singleConditionMatches(cond: AutomationCondition, st: LiveMatchState, side: number): boolean {
  switch (cond) {
    case "ANY":
      return true;
    case "WINNING":
      return marginForSide(st, side) > 0;
    case "LOSING":
      return marginForSide(st, side) < 0;
    case "DRAWING":
      return marginForSide(st, side) === 0;
    case "WINNING_BY_2":
      return marginForSide(st, side) >= 2;
    case "LOSING_BY_2":
      return marginForSide(st, side) <= -2;
    case "WINNING_OR_DRAWING":
      return marginForSide(st, side) >= 0;
    case "LOSING_OR_DRAWING":
      return marginForSide(st, side) <= 0;
    case "A_MAN_DOWN":
      return onPitchIdsForSide(st, side).length < onPitchIdsForSide(st, 1 - side).length;
    case "A_MAN_UP":
      return onPitchIdsForSide(st, side).length > onPitchIdsForSide(st, 1 - side).length;
    case "TIRED_PLAYER_ON_PITCH":
      return onPitchIdsForSide(st, side).some((id) => (st.playerEnergy[id] ?? 100) < AUTOMATION_CONFIG.tiredEnergyThreshold);
    case "BOOKED_PLAYER_ON_PITCH":
      return onPitchIdsForSide(st, side).some((id) => (st.playerYellows[id] ?? 0) > 0);
    case "HAS_SUBS_LEFT":
      return st.usedSubs[side] < MP_CONFIG.maxSubsPerSide;
    case "LOSING_POSSESSION": {
      const total = st.controlledBallSeconds[0] + st.controlledBallSeconds[1];
      if (total <= 0) return false;
      return st.controlledBallSeconds[side] / total < AUTOMATION_CONFIG.lowPossessionShare;
    }
    default:
      return false;
  }
}

/** All of a rule's conditions must hold (AND). Empty/legacy-absent means unconditional. */
function allConditionsMatch(conditions: AutomationCondition[], st: LiveMatchState, side: number): boolean {
  if (conditions.length === 0) return true;
  return conditions.every((c) => singleConditionMatches(c, st, side));
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

/** Whether this trigger fired this minute given the new events batch and current minute. */
function triggerMatches(
  rule: AutomationRule,
  st: LiveMatchState,
  side: number,
  newEventsThisMinute: import("./types").MatchEvent[],
  minute: number,
  clubId: number
): boolean {
  const k = rule.trigger.kind as AutomationTriggerKind;
  if (k === "MINUTE") return minute === rule.trigger.minute;
  if (k === "HALF_TIME") {
    // Robust half-time: isHalftime covers the exact HT instant (and the whole
    // human-vs-human wall-clock pause, since world.ts now evaluates
    // automation on every tick of that pause). The period-2 fallback window
    // below is only a belt-and-braces catch for any path that never truly
    // pauses (e.g. an admin's forced completion) — its bound mirrors
    // isHalftime's own boundary (added time included) so the two never disagree.
    if (isHalftime(st)) return true;
    const firstEnd = MS.timing.firstHalfEndSeconds + (st.firstHalfAddedMinutes ?? 0) * 60;
    return st.period === 2 && st.matchClockSeconds >= firstEnd && st.matchClockSeconds < firstEnd + 60;
  }
  if (k === "GOAL_SCORED") return newEventsThisMinute.some((e) => e.type === EVENT_CODES.GOAL && e.clubId === clubId);
  if (k === "GOAL_CONCEDED") return newEventsThisMinute.some((e) => e.type === EVENT_CODES.GOAL && e.clubId !== clubId);
  if (k === "RED_CARD") return newEventsThisMinute.some((e) => (e.type === EVENT_CODES.RED || e.type === EVENT_CODES.YELLOW_RED) && e.clubId === clubId);
  if (k === "YELLOW_CARD") return newEventsThisMinute.some((e) => e.type === EVENT_CODES.YELLOW && e.clubId === clubId);
  if (k === "OPPONENT_RED_CARD") return newEventsThisMinute.some((e) => (e.type === EVENT_CODES.RED || e.type === EVENT_CODES.YELLOW_RED) && e.clubId !== clubId);
  if (k === "PLAYER_INJURED") return newEventsThisMinute.some((e) => e.type === EVENT_CODES.INJURY && e.clubId === clubId);
  if (k === "MISSED_PENALTY") return newEventsThisMinute.some((e) => e.type === EVENT_CODES.MISSED_PENALTY && e.clubId === clubId);
  void side;
  return false;
}

// ---------------------------------------------------------------------------
// Dynamic player selectors (plan §11 "reliability" — a rule that names a
// role/state instead of two hard-coded ids survives ordinary squad churn).
// Every selector is deterministic with an explicit lower-id tie-break, the
// same convention as pickInjuryReplacement/pickAiReplacement, so a retry or
// restart can never resolve a different candidate.
// ---------------------------------------------------------------------------

function playerAtSlot(st: LiveMatchState, side: number, slotIndex: number): number | null {
  const slotMap = side === 0 ? st.homeSlotByPlayerId : st.awaySlotByPlayerId;
  if (!slotMap) return null;
  for (const key of Object.keys(slotMap)) {
    if (slotMap[Number(key)] === slotIndex) return Number(key);
  }
  return null;
}

/** Most-tired eligible outfielder currently on the pitch for this side. */
function mostTiredOnPitch(st: LiveMatchState, side: number, byId: (id: number) => Player | null): number | null {
  let best: { id: number; energy: number } | null = null;
  for (const id of onPitchIdsForSide(st, side)) {
    const p = byId(id);
    if (!p) continue;
    if (resolveDeployedSlot(st, side, id, p).role === "GK") continue;
    const energy = st.playerEnergy[id] ?? p.energy;
    if (!best || energy < best.energy || (energy === best.energy && id < best.id)) best = { id, energy };
  }
  return best?.id ?? null;
}

/** Most-booked (then most-tired, then lowest id) outfielder on the pitch. */
function bookedOnPitch(st: LiveMatchState, side: number, byId: (id: number) => Player | null): number | null {
  let best: { id: number; yellows: number; energy: number } | null = null;
  for (const id of onPitchIdsForSide(st, side)) {
    const yellows = st.playerYellows[id] ?? 0;
    if (yellows <= 0) continue;
    const p = byId(id);
    if (!p) continue;
    if (resolveDeployedSlot(st, side, id, p).role === "GK") continue;
    const energy = st.playerEnergy[id] ?? p.energy;
    if (!best || yellows > best.yellows || (yellows === best.yellows && (energy < best.energy || (energy === best.energy && id < best.id)))) {
      best = { id, yellows, energy };
    }
  }
  return best?.id ?? null;
}

interface SubResolution {
  outId: number | null;
  inId: number | null;
  reason?: number;
}

/** Resolve a SUB action's out/in player ids from its selector modes. PLAYER
 *  mode reproduces the original hard-coded-id behaviour unchanged. */
function resolveSubPlayers(action: AutomationAction, st: LiveMatchState, side: number, byId: (id: number) => Player | null): SubResolution {
  const outSelect = (action.outSelect ?? "PLAYER") as AutomationOutSelect;
  let outId: number | null;
  if (outSelect === "PLAYER") outId = action.outPlayerId ?? null;
  else if (outSelect === "SLOT") outId = action.outSlotIndex !== undefined ? playerAtSlot(st, side, action.outSlotIndex) : null;
  else if (outSelect === "MOST_TIRED") outId = mostTiredOnPitch(st, side, byId);
  else outId = bookedOnPitch(st, side, byId); // BOOKED
  if (outId === null) return { outId: null, inId: null, reason: AUTOMATION_REASON.NO_CANDIDATE };

  const outPlayer = byId(outId);
  const inSelect = (action.inSelect ?? "PLAYER") as AutomationInSelect;
  let inId: number | null;
  if (inSelect === "PLAYER") {
    inId = action.inPlayerId ?? null;
  } else if (!outPlayer) {
    inId = null;
  } else {
    // BEST_FOR_ROLE: the same authority §5.6 uses for injury replacements
    // (game/matchSim.ts pickInjuryReplacement) — no second picker.
    const outRole = resolveDeployedSlot(st, side, outId, outPlayer).role;
    const bench = benchIdsForSide(st, side)
      .map(byId)
      .filter((p): p is Player => !!p);
    const pick = pickInjuryReplacement(bench, outRole, (p) => st.playerEnergy[p.id] ?? p.energy);
    inId = pick?.id ?? null;
  }
  if (inId === null) return { outId, inId: null, reason: AUTOMATION_REASON.NO_CANDIDATE };
  return { outId, inId };
}

/** Map a performLiveSub failure string to a stable reason code (the string is
 *  UI-facing prose for the manual-sub path; automation logs a code instead —
 *  AGENTS.md: server payloads carry codes/message keys, never prose). */
function subErrorReason(error: string): number {
  if (error === "No substitutions left") return AUTOMATION_REASON.NO_SUBS_LEFT;
  if (error === "Player not on the pitch") return AUTOMATION_REASON.OUT_NOT_ON_PITCH;
  if (error === "Player not on the bench") return AUTOMATION_REASON.IN_NOT_ON_BENCH;
  if (error === "Replace the goalkeeper with another goalkeeper" || error === "A goalkeeper cannot enter an outfield slot") return AUTOMATION_REASON.GK_MISMATCH;
  if (error === "Match already finished") return AUTOMATION_REASON.MATCH_ENDED;
  return AUTOMATION_REASON.INVALID_CONFIG;
}

// ---------------------------------------------------------------------------
// Fire-count bookkeeping (plan §11: a rule applies at most `maxFires` times,
// default 1). A fire is consumed ONLY on a successful application — a SKIPPED
// evaluation (cooldown, no candidate this minute, etc.) never spends it, so
// the rule can retry the next time its trigger/condition match again. This is
// the fix for the tactics-cooldown and half-time defects: neither silently
// burns the rule any more.
// ---------------------------------------------------------------------------

function fireKey(presetId: string, ruleId: string): string {
  return `${presetId}:${ruleId}`;
}

function currentFireCount(st: LiveMatchState, key: string, bareLegacyId: string): number {
  const explicit = st.automationFireCounts?.[key];
  if (explicit !== undefined) return explicit;
  // Back-compat: a match already in flight when this shipped may only have
  // the old fired-id set, where presence means "fired exactly once".
  const fired = st.automationFiredRuleIds;
  if (fired && (fired.includes(key) || fired.includes(bareLegacyId))) return 1;
  return 0;
}

function recordFire(st: LiveMatchState, key: string, count: number): void {
  st.automationFireCounts ??= {};
  st.automationFireCounts[key] = count;
}

function ruleMaxFires(rule: AutomationRule): number {
  const raw = rule.maxFires ?? AUTOMATION_CONFIG.defaultMaxFires;
  return Math.max(1, Math.min(raw, AUTOMATION_CONFIG.maxFiresCap));
}

// ---------------------------------------------------------------------------
// Outcome log (plan §11 "reliability"): every evaluated-and-attempted rule
// appends exactly one entry. Private per side — never shown to the opponent
// or a spectator (same footing as hidden player quality, AGENTS.md "no
// hidden/misleading information" read in reverse: the OPPONENT must not see
// this side's strategy, not that the owner is hidden from itself).
// ---------------------------------------------------------------------------

function appendLog(st: LiveMatchState, entry: { side: 0 | 1; presetId: string; ruleId: string; actionIndex?: number; minute: number; status: "APPLIED" | "SKIPPED" | "RETIRED"; reason?: number }): void {
  st.automationLog ??= [];
  st.automationLog.push(entry);
  const overflow = st.automationLog.length - AUTOMATION_CONFIG.maxLogEntries;
  if (overflow > 0) st.automationLog.splice(0, overflow);
}

function pushAutomationEvent(st: LiveMatchState, clubId: number, subtype: number, playerId: number | null, player2Id: number | null): void {
  st.events.push({ minute: st.minute, half: st.period, type: EVENT_CODES.AUTOMATION, subtype, clubId, playerId, player2Id, goalType: 0 });
}

// ---------------------------------------------------------------------------
// Single-action execution. A rule now queues one or more actions (plan §11
// "more than one THEN"); every action runs independently in order, each
// getting its own outcome/log entry, so a rule stays legible even when one of
// its actions can't apply this minute.
// ---------------------------------------------------------------------------

interface ActionOutcome {
  status: "APPLIED" | "SKIPPED";
  reason?: number;
  /** Set only on APPLIED — pushAutomationEvent's subtype and the two player
   *  ids it should carry (kind-dependent; both null for TACTICS/FORMATION). */
  subtype?: number;
  playerId?: number | null;
  player2Id?: number | null;
}

function executeAction(
  action: AutomationAction,
  world: World,
  st: LiveMatchState,
  side: number,
  club: Club,
  byId: (id: number | undefined) => Player | null
): ActionOutcome {
  if (action.kind === "SUB") {
    // Only performLiveSub needs both club objects (for its event's clubId).
    const home = world.clubs.find((c) => c.id === st.homeClubId);
    const away = world.clubs.find((c) => c.id === st.awayClubId);
    if (!home || !away) return { status: "SKIPPED", reason: AUTOMATION_REASON.INVALID_CONFIG };
    const resolved = resolveSubPlayers(action, st, side, byId);
    if (resolved.outId === null || resolved.inId === null) {
      return { status: "SKIPPED", reason: resolved.reason ?? AUTOMATION_REASON.NO_CANDIDATE };
    }
    const res = performLiveSub(world.rng, home, away, world.players, st, side, resolved.outId, resolved.inId);
    if (res.error) return { status: "SKIPPED", reason: subErrorReason(res.error) };
    return { status: "APPLIED", subtype: AUTOMATION_SUBTYPES.SUB, playerId: resolved.outId, player2Id: resolved.inId };
  }
  if (action.kind === "TACTICS") {
    // Mutate live tactics only (not club.tactics — that would persist beyond
    // the match). The owning club's per-setup progress feeds the §17 switch
    // penalty so automation flips behave exactly like manual live changes.
    const context = { familiarityMap: club.tacticFamiliarity, absoluteGameDay: world.mp.absoluteGameDay ?? world.dayIndex };
    const hasTacticFields = action.style !== undefined || action.pressing !== undefined || action.direction !== undefined;
    const tacticError = hasTacticFields
      ? applyLiveTacticsUpdate(st, side as 0 | 1, { style: action.style, pressing: action.pressing, direction: action.direction }, context)
      : null;
    // Formation changes require the pregame/halftime window; price the §17
    // transfer like every other setup-change pathway.
    const wantsFormation = action.formation !== undefined && (isPregame(st) || isHalftime(st));
    const formError = wantsFormation ? applyLiveFormationChange(st, side as 0 | 1, action.formation!, context) : null;
    const formationRequestedButClosed = action.formation !== undefined && !wantsFormation;
    const tacticsOk = !hasTacticFields || !tacticError;
    const formationOk = !wantsFormation || !formError;
    if (tacticsOk && formationOk && !formationRequestedButClosed) {
      return { status: "APPLIED", subtype: wantsFormation ? AUTOMATION_SUBTYPES.FORMATION : AUTOMATION_SUBTYPES.TACTICS };
    }
    const reason = tacticError
      ? AUTOMATION_REASON.TACTICS_COOLDOWN
      : formationRequestedButClosed || formError
        ? AUTOMATION_REASON.FORMATION_WINDOW_CLOSED
        : AUTOMATION_REASON.INVALID_CONFIG;
    return { status: "SKIPPED", reason };
  }
  if (action.kind === "SET_TAKER") {
    // Scoped to the live match only — unlike TACTICS, the underlying
    // preference (Club.penaltyTakerId) persists past the match, so an
    // automated change must not silently overwrite the manager's saved
    // choice (§11's TACTICS guarantee, extended here on purpose).
    const takerId = action.takerPlayerId;
    const onIds = onPitchIdsForSide(st, side);
    if (takerId === undefined || !onIds.includes(takerId)) return { status: "SKIPPED", reason: AUTOMATION_REASON.NO_CANDIDATE };
    st.livePenaltyTakerId ??= [null, null];
    st.livePenaltyTakerId[side] = takerId;
    return { status: "APPLIED", subtype: AUTOMATION_SUBTYPES.SET_TAKER, playerId: takerId };
  }
  if (action.kind === "SWAP_SLOTS") {
    const a = action.swapPlayerAId;
    const b = action.swapPlayerBId;
    const onIds = onPitchIdsForSide(st, side);
    const slotMap = side === 0 ? st.homeSlotByPlayerId : st.awaySlotByPlayerId;
    if (a === undefined || b === undefined || !onIds.includes(a) || !onIds.includes(b) || !slotMap || slotMap[a] === undefined || slotMap[b] === undefined) {
      return { status: "SKIPPED", reason: AUTOMATION_REASON.NO_CANDIDATE };
    }
    const tmp = slotMap[a];
    slotMap[a] = slotMap[b];
    slotMap[b] = tmp;
    return { status: "APPLIED", subtype: AUTOMATION_SUBTYPES.SWAP_SLOTS, playerId: a, player2Id: b };
  }
  if (action.kind === "STOP_AUTOMATION") {
    st.automationDisabled ??= [false, false];
    st.automationDisabled[side] = true;
    return { status: "APPLIED" };
  }
  if (action.kind === "HALFTIME_READY") {
    markHalftimeReady(world, st, side as 0 | 1);
    return { status: "APPLIED" }; // world.ts's own halftime loop performs the actual resume tick
  }
  return { status: "SKIPPED", reason: AUTOMATION_REASON.INVALID_CONFIG };
}

/** True if any of a rule's SUB actions names a PLAYER-mode incoming player
 *  who is permanently unavailable (injured, suspended, on sale, or no longer
 *  at this club) — such a rule can never legally complete that action, so it
 *  is retired outright rather than retried on every recurrence of its
 *  trigger. Dynamic selectors (MOST_TIRED, BOOKED, BEST_FOR_ROLE, SLOT) are
 *  excluded — their eligibility is re-evaluated fresh every attempt and
 *  already filters unavailable candidates. */
function hasPermanentlyBrokenSub(rule: AutomationRule, clubId: number, byId: (id: number | undefined) => Player | null): boolean {
  return rule.actions.some((action) => {
    if (action.kind !== "SUB" || (action.inSelect ?? "PLAYER") !== "PLAYER") return false;
    const inPlayer = byId(action.inPlayerId);
    return !inPlayer || inPlayer.clubId !== clubId || inPlayer.injuryDays > 0 || inPlayer.suspendedGames > 0 || inPlayer.onSale;
  });
}

export interface AutomationTickContext {
  minute: number;
  newEventsThisMinute: import("./types").MatchEvent[];
}

/**
 * Evaluate automation for one side of one live match; called from
 * advanceLiveMatches per simulated minute (and, for the halftime pause, once
 * per tick while paused — see game/world.ts).
 * - Only for human-owned clubs with an enabled preset matching the club's
 *   current saved formation.
 * - `presets` is supplied by the caller (services/automationPresetService.ts);
 *   presets are club-scoped configuration loaded on demand, never held on the
 *   in-memory Club/World for every club (plan §11 Part 4).
 * - Fired counts are recorded on st so restarts never double-apply.
 * - Returns true if world/live-state was mutated (persist needed).
 */
export function evaluateAutomationForMatch(params: {
  world: World;
  st: LiveMatchState;
  side: number; // 0 = home, 1 = away
  club: Club;
  presets: AutomationPreset[];
  ctx: AutomationTickContext;
}): boolean {
  const { world, st, side, club, presets, ctx } = params;
  if (st.ended) return false;
  if (st.automationDisabled?.[side]) return false;
  if (presets.length === 0) return false;
  // AI clubs never have presets (per invariant); still gate.
  if (!club.isHuman) return false;

  // Presets are per-tactic; the null branch is back-compat for any stale in-memory rows.
  const formation = club.tactics.formation;
  const armed = presets.filter((p) => p.enabled && (p.formationId === null || p.formationId === formation));
  if (armed.length === 0) return false;

  // "Mutated" here means "this call changed persisted live-state and must be
  // saved" — true for an actual gameplay effect (a sub applied, a tactic
  // changed) AND for pure bookkeeping (a log entry appended, a fire count
  // recorded), since either one left unsaved would repeat identically next
  // tick. Every appendLog call therefore flips it, via this local wrapper —
  // do not call the module-level appendLog directly inside this function.
  let mutated = false;
  const log = (entry: Parameters<typeof appendLog>[1]) => {
    appendLog(st, entry);
    mutated = true;
  };
  const clubId = club.id;

  // Lazily-built index over world.players for the SUB/SWAP_SLOTS/SET_TAKER
  // resolvers below — most rules are TACTICS and never need it, so it is only
  // built the first time a rule actually requires a player lookup.
  let playersById: Map<number, Player> | null = null;
  const byId = (id: number | undefined): Player | null => {
    if (id === undefined) return null;
    playersById ??= new Map(world.players.map((p) => [p.id, p]));
    return playersById.get(id) ?? null;
  };

  presetLoop: for (const preset of armed) {
    for (const rule of preset.rules) {
      const key = fireKey(preset.id, rule.id);
      const maxFires = ruleMaxFires(rule);
      const fireCount = currentFireCount(st, key, rule.id);
      if (fireCount >= maxFires) continue; // fully retired, silent

      // Any SUB action naming a permanently-unavailable PLAYER-mode incoming
      // player can never legally complete — retire the whole rule immediately
      // instead of letting it consume its trigger on an impossible action
      // every time the trigger recurs.
      if (hasPermanentlyBrokenSub(rule, clubId, byId)) {
        recordFire(st, key, maxFires);
        log({ side: side as 0 | 1, presetId: preset.id, ruleId: rule.id, minute: ctx.minute, status: "RETIRED", reason: AUTOMATION_REASON.IN_UNAVAILABLE });
        continue;
      }

      if (!triggerMatches(rule, st, side, ctx.newEventsThisMinute, ctx.minute, clubId)) continue;
      if (rule.fromMinute !== undefined && ctx.minute < rule.fromMinute) continue;
      if (rule.toMinute !== undefined && ctx.minute > rule.toMinute) continue;
      if (!allConditionsMatch(rule.conditions ?? [], st, side)) continue;

      // Every action in the rule runs, in order, each getting its own log
      // entry — a rule "fires" (consumes one of its maxFires) as soon as ANY
      // one of its actions actually applies; an all-skipped pass leaves it
      // fully eligible to try again next time the trigger recurs.
      let anyApplied = false;
      let stopRequested = false;
      for (let i = 0; i < rule.actions.length; i++) {
        const action = rule.actions[i];
        const outcome = executeAction(action, world, st, side, club, byId);
        log({ side: side as 0 | 1, presetId: preset.id, ruleId: rule.id, actionIndex: i, minute: ctx.minute, status: outcome.status, reason: outcome.reason });
        if (outcome.status === "APPLIED") {
          anyApplied = true;
          if (outcome.subtype !== undefined) pushAutomationEvent(st, clubId, outcome.subtype, outcome.playerId ?? null, outcome.player2Id ?? null);
          // STOP_AUTOMATION disables the rest of this side's automation for
          // the match — no point running this rule's remaining actions, or
          // any later rule in this preset/side, once it has taken effect.
          if (action.kind === "STOP_AUTOMATION") stopRequested = true;
        }
        if (stopRequested) break;
      }
      if (anyApplied) recordFire(st, key, fireCount + 1);
      if (stopRequested) break presetLoop;
    }
  }
  return mutated;
}

/**
 * Process automation for both sides of one live match for one simulated
 * minute batch (or one halftime-pause tick, where newEventsThisMinute is
 * empty). Called after tickLiveMatch appends events for that minute.
 */
export function processAutomation(
  world: World,
  st: LiveMatchState,
  newEventsThisMinute: import("./types").MatchEvent[],
  presetsByClubId: Map<number, AutomationPreset[]>
): boolean {
  let any = false;
  const sides: [Club | undefined, number][] = [
    [world.clubs.find((c) => c.id === st.homeClubId), 0],
    [world.clubs.find((c) => c.id === st.awayClubId), 1],
  ];
  for (const [club, side] of sides) {
    if (!club) continue;
    const mutated = evaluateAutomationForMatch({
      world,
      st,
      side,
      club,
      presets: presetsByClubId.get(club.id) ?? [],
      ctx: { minute: st.minute, newEventsThisMinute },
    });
    if (mutated) any = true;
  }
  return any;
}
