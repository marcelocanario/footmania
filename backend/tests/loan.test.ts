import { describe, expect, it } from "vitest";
import { loanFitsContract } from "../src/game/season";

describe("loan contract duration", () => {
  it("allows a loan that ends on or before the owning contract expiry", () => {
    expect(loanFitsContract(20, 30, 10)).toBe(true);
    expect(loanFitsContract(20, 30, 11)).toBe(true);
  });

  it("rejects a loan that outlasts the owning contract", () => {
    expect(loanFitsContract(20, 30, 9)).toBe(false);
    expect(loanFitsContract(20, 20, 10)).toBe(false);
  });
});
