import { z } from "zod";
import { AUTOMATION_CONFIG } from "../config";
import type { AutomationAction, AutomationCondition, AutomationPreset, AutomationRule, AutomationTriggerKind, Club, LiveMatchState, World } from "./types";
import { applyLiveFormationChange, applyLiveTacticsUpdate, performLiveSub } from "./match";
import { isHalftime, isPregame } from "./match";
import { DIRECTION_NAMES, EVENT_CODES, PRESSING_NAMES, STYLE_NAMES } from "./constants";
import { FORMATIONS } from "./formations";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";

// Real tactic ranges (backend/src/game/constants.ts); presets may only ever
// target values a club tactic could legitimately hold.
const MAX_FORMATION = FORMATIONS.length - 1;
const MAX_STYLE = STYLE_NAMES.length - 1;
const MAX_PRESSING = PRESSING_NAMES.length - 1;
const MAX_DIRECTION = DIRECTION_NAMES.length - 1;

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
    outPlayerId: z.number().int().optional(),
    inPlayerId: z.number().int().optional(),
    formation: z.number().int().min(0).max(MAX_FORMATION).optional(),
    style: z.number().int().min(0).max(MAX_STYLE).optional(),
    pressing: z.number().int().min(0).max(MAX_PRESSING).optional(),
    direction: z.number().int().min(0).max(MAX_DIRECTION).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "SUB" && (v.outPlayerId === undefined || v.inPlayerId === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SUB requires outPlayerId and inPlayerId" });
    if (v.kind === "TACTICS" && v.formation === undefined && v.style === undefined && v.pressing === undefined && v.direction === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TACTICS requires at least one field" });
  });

export const ruleSchema = z
  .object({
    id: z.string().min(1).max(64),
    trigger: triggerSchema,
    condition: z.enum(AUTOMATION_CONFIG.allowedConditions as unknown as [string, ...string[]]),
    action: actionSchema,
  })
  .superRefine((v, ctx) => {
    if (v.action.kind === "TACTICS" && v.action.formation !== undefined && v.trigger.kind !== "HALF_TIME") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A formation change may only trigger at half-time" });
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

/**
 * Legacy rows (pre per-tactic migration) allowed `formationId: null` ("any
 * formation") and looser tactic ranges on TACTICS actions. Stored presets are
 * parsed leniently (mirroring the OLD PUT schema), then normalized:
 * - null/out-of-range preset scopes bind to the club's current saved formation;
 * - impossible TACTICS action values are dropped, and rules left with no
 *   possible effect are removed.
 * The result always satisfies the strict presetSchema, so any later PUT round-trips cleanly.
 */
const storedActionSchema = z.object({
  kind: z.enum(AUTOMATION_CONFIG.allowedActions as unknown as [string, ...string[]]),
  outPlayerId: z.number().int().optional(),
  inPlayerId: z.number().int().optional(),
  // Legacy bounds were looser than the real tactic ranges; sanitize below.
  formation: z.number().int().min(0).max(20).optional(),
  style: z.number().int().min(0).max(20).optional(),
  pressing: z.number().int().min(0).max(20).optional(),
  direction: z.number().int().min(0).max(20).optional(),
});

const storedRuleSchema = z.object({
  id: z.string().min(1).max(64),
  trigger: triggerSchema,
  condition: z.enum(AUTOMATION_CONFIG.allowedConditions as unknown as [string, ...string[]]),
  action: storedActionSchema,
});

const storedPresetsSchema = z.array(
  z.object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(40),
    formationId: z.number().int().min(0).max(20).nullable(),
    enabled: z.boolean(),
    rules: z.array(storedRuleSchema).max(AUTOMATION_CONFIG.maxRulesPerPreset),
  })
);

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

export function parseStoredPresets(raw: unknown, fallbackFormationId: number): AutomationPreset[] | null {
  const parsed = storedPresetsSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Enum kinds were just validated by the schemas; recover the domain types.
  const stored = parsed.data as unknown as AutomationPreset[];
  const migrated: AutomationPreset[] = [];
  for (const p of stored) {
    const rules: AutomationRule[] = [];
    for (const r of p.rules) {
      if (r.action.kind !== "TACTICS") {
        rules.push(r);
        continue;
      }
      const clean = sanitizeTacticsAction(r.action, r.trigger.kind as AutomationTriggerKind);
      if (clean) rules.push({ ...r, action: clean });
    }
    migrated.push({
      ...p,
      formationId: p.formationId !== null && p.formationId >= 0 && p.formationId <= MAX_FORMATION ? p.formationId : fallbackFormationId,
      rules,
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

/** Score margin from the perspective of the owning side. */
function marginForSide(st: LiveMatchState, side: number): number {
  return side === 0 ? st.scores[0] - st.scores[1] : st.scores[1] - st.scores[0];
}

function conditionMatches(cond: AutomationCondition, margin: number): boolean {
  switch (cond) {
    case "ANY":
      return true;
    case "WINNING":
      return margin > 0;
    case "LOSING":
      return margin < 0;
    case "DRAWING":
      return margin === 0;
    case "WINNING_BY_2":
      return margin >= 2;
    case "LOSING_BY_2":
      return margin <= -2;
    default:
      return false;
  }
}

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
    // Robust half-time: isHalftime covers the exact HT instant; also catch the
    // first minute of period 2 within the HT window so per-minute stepping never misses.
    if (isHalftime(st)) return true;
    return st.period === 2 && st.matchClockSeconds >= MS.timing.firstHalfEndSeconds && st.matchClockSeconds < MS.timing.firstHalfEndSeconds + 60;
  }
  if (k === "GOAL_SCORED") return newEventsThisMinute.some((e) => e.type === EVENT_CODES.GOAL && e.clubId === clubId);
  if (k === "GOAL_CONCEDED") return newEventsThisMinute.some((e) => e.type === EVENT_CODES.GOAL && e.clubId !== clubId);
  if (k === "RED_CARD") return newEventsThisMinute.some((e) => (e.type === EVENT_CODES.RED || e.type === EVENT_CODES.YELLOW_RED) && e.clubId === clubId);
  return false;
}

export interface AutomationTickContext {
  minute: number;
  newEventsThisMinute: import("./types").MatchEvent[];
}

/**
 * Evaluate automation for all live matches; called from advanceLiveMatches per simulated minute.
 * - Only for human-owned clubs with an enabled preset matching current formation.
 * - Fired rules are recorded on st so restarts never double-fire.
 * - Returns true if world was mutated (new persist needed).
 */
export function evaluateAutomationForMatch(params: {
  world: World;
  st: LiveMatchState;
  side: number; // 0 = home, 1 = away
  club: Club;
  ctx: AutomationTickContext;
}): boolean {
  const { world, st, side, club, ctx } = params;
  if (st.ended) return false;
  if (st.automationDisabled?.[side]) return false;
  const presets = club.automationPresets ?? [];
  if (presets.length === 0) return false;
  // AI clubs never have presets (per invariant); still gate.
  if (!club.isHuman) return false;

  // Presets are per-tactic; the null branch is back-compat for any stale in-memory rows.
  const formation = club.tactics.formation;
  const armed = presets.filter((p) => p.enabled && (p.formationId === null || p.formationId === formation));
  if (armed.length === 0) return false;

  const fired = new Set(st.automationFiredRuleIds ?? []);
  let mutated = false;
  const clubId = club.id;
  const margin = marginForSide(st, side);
  // Lazily-built index of this club's roster for the permanent-eligibility
  // check below (one pass over world.players per evaluation, not per rule).
  let squadIndex: Map<number, import("./types").Player> | null = null;
  const squadPlayer = (id: number | undefined): import("./types").Player | null => {
    if (id === undefined) return null;
    squadIndex ??= new Map(world.players.filter((candidate) => candidate.clubId === clubId).map((candidate) => [candidate.id, candidate]));
    return squadIndex.get(id) ?? null;
  };

  for (const preset of armed) {
    for (const rule of preset.rules) {
      const firedKey = `${preset.id}:${rule.id}`;
      // Back-compat: old rows stored bare rule.id
      if (fired.has(firedKey) || fired.has(rule.id)) continue;
      // A SUB rule whose incoming player is permanently unavailable (injured,
      // suspended, on sale, or no longer in this squad) can never legally send
      // him onto the pitch. Discard it up front — marked fired so it never
      // refires — instead of letting it consume its trigger on an impossible
      // action. Runtime-only problems (player already used, GK mismatch) stay
      // with performLiveSub's graceful failure below.
      if (rule.action.kind === "SUB") {
        const inPlayer = squadPlayer(rule.action.inPlayerId);
        if (!inPlayer || inPlayer.injuryDays > 0 || inPlayer.suspendedGames > 0 || inPlayer.onSale) {
          fired.add(firedKey);
          st.automationFiredRuleIds = Array.from(fired);
          continue;
        }
      }
      if (!triggerMatches(rule, st, side, ctx.newEventsThisMinute, ctx.minute, clubId)) continue;
      if (!conditionMatches(rule.condition as AutomationCondition, margin)) continue;

      // Try to execute
      if (rule.action.kind === "SUB") {
        const outId = rule.action.outPlayerId!;
        const inId = rule.action.inPlayerId!;
        const home = world.clubs.find((c) => c.id === st.homeClubId);
        const away = world.clubs.find((c) => c.id === st.awayClubId);
        if (!home || !away) {
          fired.add(firedKey);
          st.automationFiredRuleIds = Array.from(fired);
          continue;
        }
        const res = performLiveSub(world.rng, home, away, world.players, st, side, outId, inId);
        // Mark fired regardless to avoid infinite retry on invalid configs
        fired.add(firedKey);
        st.automationFiredRuleIds = Array.from(fired);
        if (!res.error) mutated = true;
      } else if (rule.action.kind === "TACTICS") {
        // TACTICS: mutate live tactics only (not club.tactics — that would persist beyond the match).
        // The owning club's per-setup progress feeds the §17 switch penalty so
        // automation flips behave exactly like manual live tactic changes.
        const ownerClub = world.clubs.find((c) => c.id === (side === 0 ? st.homeClubId : st.awayClubId));
        const context = {
          familiarityMap: ownerClub?.tacticFamiliarity,
          absoluteGameDay: world.mp.absoluteGameDay ?? world.dayIndex,
        };
        const hasTacticFields = rule.action.style !== undefined || rule.action.pressing !== undefined || rule.action.direction !== undefined;
        const tacticError = hasTacticFields
          ? applyLiveTacticsUpdate(st, side as 0 | 1, {
              style: rule.action.style,
              pressing: rule.action.pressing,
              direction: rule.action.direction,
            }, context)
          : null;
        // Formation changes require the pregame/halftime window. Keep
        // automation from changing formation during live play as well, and
        // price the §17 transfer like every other setup-change pathway.
        const wantsFormation = rule.action.formation !== undefined && (isPregame(st) || isHalftime(st));
        const formError = wantsFormation
          ? applyLiveFormationChange(st, side as 0 | 1, rule.action.formation!, context)
          : null;
        fired.add(firedKey);
        st.automationFiredRuleIds = Array.from(fired);
        if ((hasTacticFields && !tacticError) || (wantsFormation && !formError)) {
          mutated = true;
        }
      }
    }
  }
  if (!mutated && st.automationFiredRuleIds?.length !== fired.size) {
    st.automationFiredRuleIds = Array.from(fired);
    // Even without a successful sub, we still want to persist the fired set to avoid refire.
    // Caller should persist if this array changed.
    return true;
  }
  return mutated;
}

/**
 * Process automation for all live matches in the world for one simulated minute batch.
 * Called after tickLiveMatch appends events for that minute.
 */
export function processAutomation(world: World, st: LiveMatchState, newEventsThisMinute: import("./types").MatchEvent[]): boolean {
  let any = false;
  const sides: [Club | undefined, number][] = [
    [world.clubs.find((c) => c.id === st.homeClubId), 0],
    [world.clubs.find((c) => c.id === st.awayClubId), 1],
  ];
  for (const [club, side] of sides) {
    if (!club) continue;
    const beforeFiredLen = st.automationFiredRuleIds?.length ?? 0;
    const mutated = evaluateAutomationForMatch({ world, st, side, club, ctx: { minute: st.minute, newEventsThisMinute } });
    const afterFiredLen = st.automationFiredRuleIds?.length ?? 0;
    if (mutated || afterFiredLen !== beforeFiredLen) any = true;
  }
  return any;
}
