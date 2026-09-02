import { describe, expect, it } from "vitest";
import { actionSchema, parseStoredPresets, presetSchema, ruleSchema, triggerSchema, validatePayloadSize, validatePresetQuotas } from "../src/game/automation";
import { AUTOMATION_CONFIG } from "../src/config";
import { DIRECTION_NAMES, PRESSING_NAMES, STYLE_NAMES } from "../src/game/constants";
import { FORMATIONS } from "../src/game/formations";
import type { AutomationPreset } from "../src/game/types";

const MIN_FORMATION = 0;
const MAX_FORMATION = FORMATIONS.length - 1;
const MAX_STYLE = STYLE_NAMES.length - 1;
const MAX_PRESSING = PRESSING_NAMES.length - 1;
const MAX_DIRECTION = DIRECTION_NAMES.length - 1;

function validRule(
  action: Record<string, unknown> = { kind: "SUB", outPlayerId: 1, inPlayerId: 2 },
  trigger: Record<string, unknown> = { kind: "MINUTE", minute: 60 },
  extra: Record<string, unknown> = {}
) {
  return {
    id: "r1",
    trigger,
    conditions: [],
    actions: [action],
    ...extra,
  };
}

function validPreset(overrides: Partial<AutomationPreset> = {}): AutomationPreset {
  return {
    id: "p1",
    name: "Test preset",
    formationId: 4,
    enabled: true,
    rules: [validRule()],
    ...overrides,
  } as AutomationPreset;
}

describe("automation schemas", () => {
  it("accepts boundary tactic values", () => {
    // Formation changes are only legal at half-time.
    const parsed = actionSchema.safeParse({ kind: "TACTICS", formation: MIN_FORMATION, style: 0, pressing: 0, direction: 0 });
    expect(parsed.success).toBe(true);
    const upper = actionSchema.safeParse({ kind: "TACTICS", formation: MAX_FORMATION, style: MAX_STYLE, pressing: MAX_PRESSING, direction: MAX_DIRECTION });
    expect(upper.success).toBe(true);
  });

  it("rejects out-of-range tactic values", () => {
    expect(actionSchema.safeParse({ kind: "TACTICS", formation: MAX_FORMATION + 1 }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: "TACTICS", style: MAX_STYLE + 1 }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: "TACTICS", pressing: MAX_PRESSING + 1 }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: "TACTICS", direction: MAX_DIRECTION + 1 }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: "TACTICS", formation: -1 }).success).toBe(false);
  });

  it("rejects formation changes on non-halftime triggers", () => {
    const minuteFormation = ruleSchema.safeParse(validRule({ kind: "TACTICS", formation: 4 }, { kind: "MINUTE", minute: 60 }));
    expect(minuteFormation.success).toBe(false);
    // The same action is fine on a half-time trigger.
    const halftimeFormation = ruleSchema.safeParse(validRule({ kind: "TACTICS", formation: 4 }, { kind: "HALF_TIME" }));
    expect(halftimeFormation.success).toBe(true);
    // Style/pressing/direction remain allowed on any trigger.
    const minuteStyle = ruleSchema.safeParse(validRule({ kind: "TACTICS", style: 1, pressing: 2 }, { kind: "MINUTE", minute: 60 }));
    expect(minuteStyle.success).toBe(true);
  });

  it("requires minute only for MINUTE triggers", () => {
    expect(triggerSchema.safeParse({ kind: "MINUTE" }).success).toBe(false);
    expect(triggerSchema.safeParse({ kind: "MINUTE", minute: 0 }).success).toBe(false);
    expect(triggerSchema.safeParse({ kind: "MINUTE", minute: 91 }).success).toBe(false);
    expect(triggerSchema.safeParse({ kind: "MINUTE", minute: 60 }).success).toBe(true);
    expect(triggerSchema.safeParse({ kind: "HALF_TIME", minute: 45 }).success).toBe(false);
    expect(triggerSchema.safeParse({ kind: "GOAL_SCORED" }).success).toBe(true);
  });

  it("requires SUB players and at least one TACTICS field", () => {
    expect(ruleSchema.safeParse(validRule({ kind: "SUB" })).success).toBe(false);
    expect(ruleSchema.safeParse(validRule({ kind: "TACTICS" })).success).toBe(false);
    expect(ruleSchema.safeParse(validRule({ kind: "TACTICS", pressing: 2 })).success).toBe(true);
  });

  it("SUB selector modes require their own matching field", () => {
    // PLAYER (implicit default) requires outPlayerId/inPlayerId, as above.
    expect(actionSchema.safeParse({ kind: "SUB", outSelect: "SLOT", inPlayerId: 2 }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: "SUB", outSelect: "SLOT", outSlotIndex: 3, inPlayerId: 2 }).success).toBe(true);
    expect(actionSchema.safeParse({ kind: "SUB", outSelect: "MOST_TIRED", inSelect: "BEST_FOR_ROLE" }).success).toBe(true);
    expect(actionSchema.safeParse({ kind: "SUB", outSelect: "BOOKED", inSelect: "BEST_FOR_ROLE" }).success).toBe(true);
    // Both PLAYER-mode: the two ids must differ.
    expect(actionSchema.safeParse({ kind: "SUB", outPlayerId: 5, inPlayerId: 5 }).success).toBe(false);
  });

  it("SET_TAKER requires a taker; SWAP_SLOTS requires two distinct players", () => {
    expect(actionSchema.safeParse({ kind: "SET_TAKER" }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: "SET_TAKER", takerPlayerId: 7 }).success).toBe(true);
    expect(actionSchema.safeParse({ kind: "SWAP_SLOTS", swapPlayerAId: 1 }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: "SWAP_SLOTS", swapPlayerAId: 1, swapPlayerBId: 1 }).success).toBe(false);
    expect(actionSchema.safeParse({ kind: "SWAP_SLOTS", swapPlayerAId: 1, swapPlayerBId: 2 }).success).toBe(true);
    expect(actionSchema.safeParse({ kind: "STOP_AUTOMATION" }).success).toBe(true);
    expect(actionSchema.safeParse({ kind: "HALFTIME_READY" }).success).toBe(true);
  });

  it("accepts an ANDed condition list up to the configured max, and rejects an unknown condition", () => {
    expect(ruleSchema.safeParse(validRule(undefined, undefined, { conditions: ["WINNING", "HAS_SUBS_LEFT"] })).success).toBe(true);
    expect(ruleSchema.safeParse(validRule(undefined, undefined, { conditions: Array(9).fill("ANY") })).success).toBe(false);
    expect(ruleSchema.safeParse(validRule(undefined, undefined, { conditions: ["NOT_A_REAL_CONDITION"] })).success).toBe(false);
  });

  it("rejects a minute-window guard on a MINUTE trigger, and an inverted window", () => {
    const guarded = validRule(undefined, { kind: "GOAL_CONCEDED" }, { fromMinute: 60, toMinute: 75 });
    expect(ruleSchema.safeParse(guarded).success).toBe(true);
    const onMinuteTrigger = validRule(undefined, { kind: "MINUTE", minute: 60 }, { fromMinute: 60, toMinute: 75 });
    expect(ruleSchema.safeParse(onMinuteTrigger).success).toBe(false);
    const inverted = validRule(undefined, { kind: "GOAL_CONCEDED" }, { fromMinute: 75, toMinute: 60 });
    expect(ruleSchema.safeParse(inverted).success).toBe(false);
  });

  it("bounds maxFires to the configured cap", () => {
    expect(ruleSchema.safeParse(validRule(undefined, undefined, { maxFires: 1 })).success).toBe(true);
    expect(ruleSchema.safeParse(validRule(undefined, undefined, { maxFires: 0 })).success).toBe(false);
    expect(ruleSchema.safeParse(validRule(undefined, undefined, { maxFires: AUTOMATION_CONFIG.maxFiresCap + 1 })).success).toBe(false);
  });

  it("requires at least one action, accepts several, and bounds the count", () => {
    expect(ruleSchema.safeParse(validRule(undefined, undefined, { actions: [] })).success).toBe(false);
    expect(
      ruleSchema.safeParse(validRule(undefined, undefined, { actions: [{ kind: "STOP_AUTOMATION" }, { kind: "HALFTIME_READY" }] })).success
    ).toBe(true);
    const tooMany = Array.from({ length: AUTOMATION_CONFIG.maxActionsPerRule + 1 }, () => ({ kind: "STOP_AUTOMATION" }));
    expect(ruleSchema.safeParse(validRule(undefined, undefined, { actions: tooMany })).success).toBe(false);
    // A formation change is still checked against HALF_TIME across every action, not just the first.
    const secondActionBad = validRule(undefined, { kind: "MINUTE", minute: 10 }, { actions: [{ kind: "STOP_AUTOMATION" }, { kind: "TACTICS", formation: 3 }] });
    expect(ruleSchema.safeParse(secondActionBad).success).toBe(false);
  });

  it("requires presets to be bound to a real formation", () => {
    expect(presetSchema.safeParse(validPreset()).success).toBe(true);
    expect(presetSchema.safeParse(validPreset({ formationId: null } as unknown as AutomationPreset)).success).toBe(false);
    expect(presetSchema.safeParse(validPreset({ formationId: -1 })).success).toBe(false);
    expect(presetSchema.safeParse(validPreset({ formationId: MAX_FORMATION + 1 })).success).toBe(false);
  });
});

describe("validatePresetQuotas", () => {
  it("allows a regular user one preset in total", () => {
    expect(validatePresetQuotas([validPreset()], false)).toBeNull();
    expect(validatePresetQuotas([validPreset(), validPreset({ id: "p2", formationId: 7 })], false)).toMatch(/at most 1/);
  });

  it("allows Pro one preset per distinct formation and rejects duplicates", () => {
    expect(validatePresetQuotas([validPreset(), validPreset({ id: "p2", formationId: 7 })], true)).toBeNull();
    expect(validatePresetQuotas([validPreset(), validPreset({ id: "p2", formationId: 4 })], true)).toMatch(/one preset per formation/);
  });
});

describe("parseStoredPresets legacy migration", () => {
  it("rebinds null-scope legacy presets to the club's current formation", () => {
    const stored = [
      {
        id: "p1",
        name: "Legacy",
        formationId: null,
        enabled: true,
        rules: [{ id: "r1", trigger: { kind: "MINUTE", minute: 75 }, condition: "LOSING", actions: [{ kind: "TACTICS", style: 1, direction: 0 }] }],
      },
    ];
    const migrated = parseStoredPresets(stored, 9);
    expect(migrated).not.toBeNull();
    expect(migrated![0].formationId).toBe(9);
  });

  it("drops impossible tactic fields and removes rules left without effect", () => {
    const stored = [
      {
        id: "p1",
        name: "Legacy",
        formationId: 4,
        enabled: true,
        rules: [
          // pressing 4 was accepted by the old loose schema; it must be dropped
          { id: "r1", trigger: { kind: "HALF_TIME" }, condition: "ANY", actions: [{ kind: "TACTICS", pressing: 4, style: 2 }] },
          // this rule only carried an invalid value, so it disappears entirely
          { id: "r2", trigger: { kind: "HALF_TIME" }, condition: "ANY", actions: [{ kind: "TACTICS", pressing: 15 }] },
        ],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules).toHaveLength(1);
    expect(migrated![0].rules[0].id).toBe("r1");
    expect(migrated![0].rules[0].actions).toEqual([{ kind: "TACTICS", style: 2 }]);
  });

  it("keeps formation only on half-time rules and strips it from other triggers", () => {
    const stored = [
      {
        id: "p1",
        name: "Legacy",
        formationId: 4,
        enabled: true,
        rules: [
          // Half-time formation change survives migration.
          { id: "r1", trigger: { kind: "HALF_TIME" }, condition: "ANY", actions: [{ kind: "TACTICS", formation: 7 }] },
          // A minute-triggered formation change can never fire; the formation
          // field is dropped while style survives.
          { id: "r2", trigger: { kind: "MINUTE", minute: 60 }, condition: "ANY", actions: [{ kind: "TACTICS", formation: 7, style: 1 }] },
          // A goal-triggered formation-only rule becomes empty and is removed.
          { id: "r3", trigger: { kind: "GOAL_SCORED" }, condition: "ANY", actions: [{ kind: "TACTICS", formation: 7 }] },
        ],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(migrated![0].rules[0].actions).toEqual([{ kind: "TACTICS", formation: 7 }]);
    expect(migrated![0].rules[1].actions).toEqual([{ kind: "TACTICS", style: 1 }]);
  });

  it("is stable across repeated parses (no duplication or drift)", () => {
    const stored = [
      { id: "p1", name: "X", formationId: null, enabled: true, rules: [] as AutomationPreset["rules"] },
    ];
    const first = parseStoredPresets(stored, 3);
    const second = parseStoredPresets(first, 5);
    expect(second).toEqual(first);
    expect(second![0].formationId).toBe(3);
  });

  it("returns null for corrupt payloads", () => {
    expect(parseStoredPresets("not-an-array", 4)).toBeNull();
    expect(parseStoredPresets([{ id: "p1" }], 4)).toBeNull();
    expect(parseStoredPresets(null, 4)).toBeNull();
  });

  it("lifts a legacy singular condition into a one-element conditions list", () => {
    const stored = [
      {
        id: "p1",
        name: "Legacy",
        formationId: 4,
        enabled: true,
        rules: [{ id: "r1", trigger: { kind: "MINUTE", minute: 75 }, condition: "LOSING", actions: [{ kind: "TACTICS", style: 1 }] }],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules[0].conditions).toEqual(["LOSING"]);
  });

  it("drops an unknown legacy condition value rather than rejecting the whole rule", () => {
    const stored = [
      {
        id: "p1",
        name: "Legacy",
        formationId: 4,
        enabled: true,
        rules: [{ id: "r1", trigger: { kind: "MINUTE", minute: 75 }, condition: "SOME_RETIRED_CONDITION", actions: [{ kind: "TACTICS", style: 1 }] }],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules[0].conditions).toEqual([]);
  });

  it("strips a minute-window guard that is redundant on a MINUTE trigger, or inverted", () => {
    const stored = [
      {
        id: "p1",
        name: "Legacy",
        formationId: 4,
        enabled: true,
        rules: [
          { id: "r1", trigger: { kind: "MINUTE", minute: 60 }, conditions: [], fromMinute: 10, toMinute: 80, actions: [{ kind: "TACTICS", style: 1 }] },
          { id: "r2", trigger: { kind: "GOAL_CONCEDED" }, conditions: [], fromMinute: 80, toMinute: 10, actions: [{ kind: "TACTICS", style: 1 }] },
        ],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules[0].fromMinute).toBeUndefined();
    expect(migrated![0].rules[0].toMinute).toBeUndefined();
    expect(migrated![0].rules[1].fromMinute).toBeUndefined();
    expect(migrated![0].rules[1].toMinute).toBeUndefined();
  });

  it("truncates a preset's rules to the structural cap rather than discarding it entirely", () => {
    const rules = Array.from({ length: AUTOMATION_CONFIG.maxRulesPerPreset + 20 }, (_, i) => ({
      id: `r${i}`,
      trigger: { kind: "MINUTE", minute: 1 + (i % 90) },
      conditions: [] as string[],
      actions: [{ kind: "TACTICS", style: 1 }],
    }));
    const stored = [{ id: "p1", name: "Huge", formationId: 4, enabled: true, rules }];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules).toHaveLength(AUTOMATION_CONFIG.maxRulesPerPreset);
  });

  it("passes new action kinds through the legacy migration unchanged", () => {
    const stored = [
      {
        id: "p1",
        name: "New actions",
        formationId: 4,
        enabled: true,
        rules: [
          { id: "r1", trigger: { kind: "MINUTE", minute: 10 }, conditions: [], actions: [{ kind: "SET_TAKER", takerPlayerId: 9 }] },
          { id: "r2", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SWAP_SLOTS", swapPlayerAId: 1, swapPlayerBId: 2 }] },
          { id: "r3", trigger: { kind: "MINUTE", minute: 30 }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] },
        ],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules.map((r) => r.actions[0].kind)).toEqual(["SET_TAKER", "SWAP_SLOTS", "STOP_AUTOMATION"]);
  });

  it("lifts a legacy singular action into a one-element actions list", () => {
    const stored = [
      {
        id: "p1",
        name: "Pre-multi-action",
        formationId: 4,
        enabled: true,
        rules: [{ id: "r1", trigger: { kind: "MINUTE", minute: 10 }, conditions: [], action: { kind: "STOP_AUTOMATION" } }],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules[0].actions).toEqual([{ kind: "STOP_AUTOMATION" }]);
  });

  it("drops a rule left with zero surviving actions after TACTICS sanitization", () => {
    const stored = [
      {
        id: "p1",
        name: "Empty after sanitize",
        formationId: 4,
        enabled: true,
        rules: [
          // The only action is a formation-only TACTICS change on a non-half-time
          // trigger: sanitizeTacticsAction drops it, leaving zero actions, so the
          // whole rule must be dropped rather than kept with an empty list.
          { id: "r1", trigger: { kind: "GOAL_SCORED" }, conditions: [], actions: [{ kind: "TACTICS", formation: 7 }] },
          { id: "r2", trigger: { kind: "MINUTE", minute: 10 }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] },
        ],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules.map((r) => r.id)).toEqual(["r2"]);
  });

  it("truncates a rule's actions to the structural cap rather than discarding it entirely", () => {
    const actions = Array.from({ length: AUTOMATION_CONFIG.maxActionsPerRule + 5 }, () => ({ kind: "STOP_AUTOMATION" }));
    const stored = [
      {
        id: "p1",
        name: "Huge rule",
        formationId: 4,
        enabled: true,
        rules: [{ id: "r1", trigger: { kind: "MINUTE", minute: 10 }, conditions: [], actions }],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules[0].actions).toHaveLength(AUTOMATION_CONFIG.maxActionsPerRule);
  });
});

describe("validatePayloadSize", () => {
  it("accepts a normal-sized preset list and rejects an oversized one", () => {
    expect(validatePayloadSize([validPreset()])).toBeNull();
    // A structural abuse guard, not a gameplay limit: a single field padded
    // well past the byte cap is enough to trip it regardless of rule count.
    const oversized = { ...validPreset(), name: "x".repeat(AUTOMATION_CONFIG.maxAutomationPayloadBytes + 1000) } as unknown as AutomationPreset;
    expect(validatePayloadSize([oversized])).toMatch(/too large/);
  });
});
