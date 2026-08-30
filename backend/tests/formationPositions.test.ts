import { describe, expect, it } from "vitest";
import { FORMATIONS } from "../src/game/formations";

describe("formation catalog", () => {
  it("keeps every displayed slot label aligned with lineup position selection", () => {
    for (const formation of FORMATIONS) {
      for (const slot of formation.slots) {
        expect(slot.label).toBe(slot.role);
      }
    }
  });

  it("uses three center-backs for the 3-5-2 back line", () => {
    const backLine = FORMATIONS[9].slots.slice(1, 4);
    expect(backLine.map((slot) => slot.role)).toEqual(["CB", "CB", "CB"]);
  });

  it("keeps every named formation at eleven unique slots with one goalkeeper", () => {
    expect(FORMATIONS).toHaveLength(23);
    for (const formation of FORMATIONS) {
      expect(formation.slots).toHaveLength(11);
      expect(new Set(formation.slots.map((s) => s.key)).size).toBe(11);
      expect(formation.slots.filter((s) => s.role === "GK")).toHaveLength(1);
    }
  });

  it("assigns exact y-derived lanes: the diamond AM1/AM2/AM3 are LEFT/RIGHT/CENTRE", () => {
    const diamond = FORMATIONS[5];
    const ams = diamond.slots.filter((s) => s.role === "AM");
    expect(ams.map((s) => s.lane)).toEqual(["LEFT", "RIGHT", "CENTRE"]);
  });

  it("covers all nine deployed roles across the catalog", () => {
    const roles = new Set(FORMATIONS.flatMap((f) => f.slots.map((s) => s.role)));
    expect(roles.size).toBe(9);
  });

  it("uses no legacy sub-roles anywhere in the catalog", () => {
    const roles = new Set<string>(FORMATIONS.flatMap((f) => f.slots.map((s) => s.role)));
    for (const legacy of ["SW", "LM", "RM"]) expect(roles.has(legacy)).toBe(false);
  });
});
