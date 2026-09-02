/**
 * Client-side mirror of backend/src/game/constants.ts's AUTOMATION_REASON
 * numeric codes. The server only ever sends the code (AGENTS.md: server
 * payloads carry codes/message keys, never prose); this file is the single
 * place that turns a code into an i18n key for every automation log renderer
 * (LiveMatch's live card, MatchHistory's post-match feed).
 */
export const AUTOMATION_REASON_KEYS: Record<number, string> = {
  1: "automation.reasonNoSubsLeft",
  2: "automation.reasonOutNotOnPitch",
  3: "automation.reasonInNotOnBench",
  4: "automation.reasonGkMismatch",
  5: "automation.reasonTacticsCooldown",
  6: "automation.reasonFormationWindowClosed",
  7: "automation.reasonInUnavailable",
  8: "automation.reasonNoCandidate",
  9: "automation.reasonMatchEnded",
  10: "automation.reasonInvalidConfig",
};

export function automationReasonKey(reason: number | undefined): string {
  if (reason === undefined) return "automation.reasonUnknown";
  return AUTOMATION_REASON_KEYS[reason] ?? "automation.reasonUnknown";
}

/** EVENT_CODES.AUTOMATION's subtype (game/constants.ts AUTOMATION_SUBTYPES). */
export const AUTOMATION_SUBTYPE_KEYS: Record<number, string> = {
  1: "automation.subtypeSub",
  2: "automation.subtypeTactics",
  3: "automation.subtypeFormation",
  4: "automation.subtypeSetTaker",
  5: "automation.subtypeSwapSlots",
};

export function automationSubtypeKey(subtype: number): string {
  return AUTOMATION_SUBTYPE_KEYS[subtype] ?? "automation.subtypeSub";
}
