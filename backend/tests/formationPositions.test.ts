import { describe, expect, it } from "vitest";
import { tacPosToBasePosition } from "../src/game/club";
import { FORMATION_NAMES, FORMATION_POSITIONS, POSITION_NAMES, TACTICAL_POSITION_NAMES } from "../src/game/constants";

describe("formation tactical positions", () => {
  it("keeps every displayed slot label aligned with lineup position selection", () => {
    for (let tacPos = 1; tacPos <= 25; tacPos++) {
      expect(TACTICAL_POSITION_NAMES[tacPos]).toBe(POSITION_NAMES[tacPosToBasePosition(tacPos)]);
    }
  });

  it("uses three center-backs for the 3-5-2 back line", () => {
    const backLine = FORMATION_POSITIONS[9].slice(6, 9);

    expect(backLine).toEqual([4, 6, 8]);
    expect(backLine.map((tacPos) => TACTICAL_POSITION_NAMES[tacPos])).toEqual(["CB", "CB", "CB"]);
  });

  it("keeps every named formation at eleven unique tactical slots with one goalkeeper", () => {
    expect(FORMATION_POSITIONS).toHaveLength(FORMATION_NAMES.length);
    for (const formation of FORMATION_POSITIONS) {
      expect(formation).toHaveLength(11);
      expect(new Set(formation).size).toBe(11);
      expect(formation.filter((tacPos) => tacPos === 1)).toHaveLength(1);
    }
  });
});
