import { describe, expect, it } from "vitest";
import type { LiveMatchState } from "../src/game/types";
import { applyLiveTacticsUpdate, tacticsCooldownMinutesRemaining } from "../src/game/match";
import { MP_CONFIG } from "../src/config";

function state(): LiveMatchState {
  return {
    ended: false,
    minute: 0,
    homeTactics: { formation: 4, style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 },
    awayTactics: { formation: 7, style: "COUNTER", pressing: 1, direction: "WIDE", familiarity: 50 },
  } as LiveMatchState;
}

describe("live tactics updates", () => {
  it("maps player tactic choices onto the live engine state", () => {
    const st = state();

    expect(applyLiveTacticsUpdate(st, 0, { style: 1, pressing: 2, direction: 1 })).toBeNull();
    expect(st.homeTactics).toMatchObject({ style: "PRESS", pressing: 1, direction: "WIDE" });

    expect(applyLiveTacticsUpdate(st, 1, { style: 0, pressing: 0, direction: 0 })).toBeNull();
    expect(st.awayTactics).toMatchObject({ style: "CONTROL", pressing: 0, direction: "CENTRE" });
  });

  it("rejects empty or invalid updates without changing tactics", () => {
    const st = state();
    expect(applyLiveTacticsUpdate(st, 0, {})).toBe("At least one tactic is required");
    expect(applyLiveTacticsUpdate(st, 0, { style: 3 })).toBe("Invalid style");
    expect(applyLiveTacticsUpdate(st, 0, { pressing: -1 })).toBe("Invalid pressing");
    expect(applyLiveTacticsUpdate(st, 0, { direction: 2 })).toBe("Invalid direction");
    expect(st.homeTactics).toMatchObject({ style: "CONTROL", pressing: 0, direction: "CENTRE" });
  });

  it("does not allow changes after full time", () => {
    const st = state();
    st.ended = true;
    expect(applyLiveTacticsUpdate(st, 0, { style: 2 })).toBe("Match already finished");
  });

  it("locks repeat changes until the configured cooldown elapses, per side", () => {
    const st = state();
    st.minute = 10;
    expect(applyLiveTacticsUpdate(st, 0, { style: 1 })).toBeNull();

    // Same side inside the window: rejected with the remaining minutes.
    st.minute = 12;
    const rejection = applyLiveTacticsUpdate(st, 0, { style: 2 });
    expect(rejection).toMatch(/locked/i);
    expect(tacticsCooldownMinutesRemaining(st, 0)).toBe(MP_CONFIG.liveMatchTacticsCooldownMatchMinutes - 2);
    // The rejected change must not have been applied.
    expect(st.homeTactics).toMatchObject({ style: "PRESS" });

    // The other side is independent and may still change.
    expect(applyLiveTacticsUpdate(st, 1, { pressing: 2 })).toBeNull();

    // After the cooldown the first side may change again.
    st.minute = 10 + MP_CONFIG.liveMatchTacticsCooldownMatchMinutes;
    expect(applyLiveTacticsUpdate(st, 0, { style: 2 })).toBeNull();
    expect(st.homeTactics.style).toBe("COUNTER");
  });

  it("always allows a side's first change of the match", () => {
    const st = state();
    delete (st as { tacticsChangedAtMinute?: unknown }).tacticsChangedAtMinute;
    st.minute = 88;
    expect(tacticsCooldownMinutesRemaining(st, 1)).toBe(0);
    expect(applyLiveTacticsUpdate(st, 1, { direction: 1 })).toBeNull();
  });
});
