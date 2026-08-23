import { describe, expect, it } from "vitest";
import type { LiveMatchState } from "../src/game/types";
import { applyLiveTacticsUpdate } from "../src/game/match";

function state(): LiveMatchState {
  return {
    ended: false,
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
});
