import { describe } from "vitest";

export function calibrationDescribe(name: string, fn: () => void): void {
  describe(`[calibration] ${name}`, fn);
}
