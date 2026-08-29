import { describe, expect, it } from "vitest";
import { actionSchema, parseStoredPresets, presetSchema, ruleSchema, triggerSchema, validatePresetQuotas } from "../src/game/automation";
import { DIRECTION_NAMES, PRESSING_NAMES, STYLE_NAMES } from "../src/game/constants";
import { FORMATIONS } from "../src/game/formations";
import type { AutomationPreset } from "../src/game/types";

const MIN_FORMATION = 0;
const MAX_FORMATION = FORMATIONS.length - 1;
const MAX_STYLE = STYLE_NAMES.length - 1;
const MAX_PRESSING = PRESSING_NAMES.length - 1;
const MAX_DIRECTION = DIRECTION_NAMES.length - 1;

function validRule(action: Record<string, unknown> = { kind: "SUB", outPlayerId: 1, inPlayerId: 2 }, trigger: Record<string, unknown> = { kind: "MINUTE", minute: 60 }) {
  return {
    id: "r1",
    trigger,
    condition: "ANY",
    action,
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
        rules: [{ id: "r1", trigger: { kind: "MINUTE", minute: 75 }, condition: "LOSING", action: { kind: "TACTICS", style: 1, direction: 0 } }],
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
          { id: "r1", trigger: { kind: "HALF_TIME" }, condition: "ANY", action: { kind: "TACTICS", pressing: 4, style: 2 } },
          // this rule only carried an invalid value, so it disappears entirely
          { id: "r2", trigger: { kind: "HALF_TIME" }, condition: "ANY", action: { kind: "TACTICS", formation: 15 } },
        ],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules).toHaveLength(1);
    expect(migrated![0].rules[0].id).toBe("r1");
    expect(migrated![0].rules[0].action).toEqual({ kind: "TACTICS", style: 2 });
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
          { id: "r1", trigger: { kind: "HALF_TIME" }, condition: "ANY", action: { kind: "TACTICS", formation: 7 } },
          // A minute-triggered formation change can never fire; the formation
          // field is dropped while style survives.
          { id: "r2", trigger: { kind: "MINUTE", minute: 60 }, condition: "ANY", action: { kind: "TACTICS", formation: 7, style: 1 } },
          // A goal-triggered formation-only rule becomes empty and is removed.
          { id: "r3", trigger: { kind: "GOAL_SCORED" }, condition: "ANY", action: { kind: "TACTICS", formation: 7 } },
        ],
      },
    ];
    const migrated = parseStoredPresets(stored, 4);
    expect(migrated).not.toBeNull();
    expect(migrated![0].rules.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(migrated![0].rules[0].action).toEqual({ kind: "TACTICS", formation: 7 });
    expect(migrated![0].rules[1].action).toEqual({ kind: "TACTICS", style: 1 });
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
});
