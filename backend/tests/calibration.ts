import { beforeEach, describe } from "vitest";

/** Hands the worker's event loop one macrotask turn. */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

export function calibrationDescribe(name: string, fn: () => void): void {
  describe(`[calibration] ${name}`, () => {
    // Calibration bodies are long synchronous CPU loops. Nothing in them awaits a
    // macrotask, so the worker's event loop never reaches the poll phase and the
    // reply to Vitest's `onTaskUpdate` RPC sits unread in the IPC queue. birpc's
    // 60s timeout is hard-coded (no config knob), so once the uninterrupted span
    // crosses it the run reports `Timeout calling "onTaskUpdate"` as an unhandled
    // error and exits non-zero — with every test green. Turning the loop between
    // tests bounds that span to one test; the few tests long enough to approach
    // 60s on their own also yield inside their sampling loops.
    beforeEach(yieldToEventLoop);
    fn();
  });
}
