import { DEPLOYED_ROLES, type DeployedRole } from "./positions";

export type TacticalLane = "LEFT" | "CENTRE" | "RIGHT";
export type TacticalLine = "GOAL" | "DEFENCE" | "DEFENSIVE_MIDFIELD" | "MIDFIELD" | "ATTACKING_MIDFIELD" | "ATTACK";

export interface FormationSlot {
  key: string;
  role: DeployedRole;
  lane: TacticalLane;
  line: TacticalLine;
  x: number;
  y: number;
  label: string;
}

export interface FormationDefinition {
  id: number;
  name: string;
  slots: readonly FormationSlot[];
}

function laneFromY(y: number): TacticalLane {
  if (y < 50) return "LEFT";
  if (y > 50) return "RIGHT";
  return "CENTRE";
}

function lineFromRole(role: DeployedRole): TacticalLine {
  if (role === "GK") return "GOAL";
  if (role === "LB" || role === "RB" || role === "CB") return "DEFENCE";
  if (role === "DM") return "DEFENSIVE_MIDFIELD";
  if (role === "AM") return "ATTACKING_MIDFIELD";
  return "ATTACK";
}

function buildLine(x: number, roles: string[]): FormationSlot[] {
  const n = roles.length;
  let ys: number[];
  if (n === 1) ys = [50];
  else if (n === 2) ys = [35, 65];
  else ys = roles.map((_, i) => Math.round(20 + (i * 60) / (n - 1)));
  return roles.map((raw, i) => {
    const role = raw.replace(/\d+$/, "") as DeployedRole;
    const key = raw;
    const y = ys[i];
    return {
      key,
      role,
      lane: laneFromY(y),
      line: lineFromRole(role),
      x,
      y,
      label: role,
    };
  });
}

/**
 * Build and validate one formation at module load, so a malformed catalog is a
 * startup crash rather than a subtly wrong pitch. Checks: exactly 11 slots,
 * unique slot keys, exactly one GK, and coordinates inside 0..100.
 */
function def(id: number, name: string, lines: { x: number; roles: string[] }[]): FormationDefinition {
  const slots = [...buildLine(8, ["GK"]), ...lines.flatMap((l) => buildLine(l.x, l.roles))];
  const where = `Formation ${id} (${name})`;
  if (slots.length !== 11) throw new Error(`${where} must have 11 slots, got ${slots.length}`);
  const keys = new Set(slots.map((s) => s.key));
  if (keys.size !== slots.length) throw new Error(`${where} has duplicate slot keys`);
  const goalkeepers = slots.filter((s) => s.role === "GK");
  if (goalkeepers.length !== 1) throw new Error(`${where} must have exactly one GK slot, got ${goalkeepers.length}`);
  if (slots[0].role !== "GK") throw new Error(`${where} must list the goalkeeper first`);
  for (const slot of slots) {
    if (!Number.isFinite(slot.x) || slot.x < 0 || slot.x > 100) throw new Error(`${where} slot ${slot.key} has x ${slot.x} outside 0..100`);
    if (!Number.isFinite(slot.y) || slot.y < 0 || slot.y > 100) throw new Error(`${where} slot ${slot.key} has y ${slot.y} outside 0..100`);
  }
  return { id, name, slots };
}

export const FORMATIONS: readonly FormationDefinition[] = [
  def(0, "5-4-1", [
    { x: 25, roles: ["LB", "CB1", "CB2", "CB3", "RB"] },
    { x: 45, roles: ["AM1", "DM1", "DM2", "AM2"] },
    { x: 68, roles: ["ST"] },
  ]),
  def(1, "5-4-1 Wide", [
    { x: 25, roles: ["LB", "CB1", "CB2", "CB3", "RB"] },
    { x: 38, roles: ["DM1", "DM2"] },
    { x: 54, roles: ["AM1", "AM2"] },
    { x: 70, roles: ["ST"] },
  ]),
  def(2, "5-3-2", [
    { x: 25, roles: ["LB", "CB1", "CB2", "CB3", "RB"] },
    { x: 45, roles: ["DM", "AM1", "AM2"] },
    { x: 68, roles: ["ST1", "ST2"] },
  ]),
  def(3, "4-5-1", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 45, roles: ["AM1", "DM1", "DM2", "DM3", "AM2"] },
    { x: 68, roles: ["ST"] },
  ]),
  def(4, "4-4-2", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 45, roles: ["AM1", "DM1", "DM2", "AM2"] },
    { x: 68, roles: ["ST1", "ST2"] },
  ]),
  def(5, "4-4-2 Diamond", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 36, roles: ["DM"] },
    { x: 46, roles: ["AM1", "AM2"] },
    { x: 56, roles: ["AM3"] },
    { x: 70, roles: ["ST1", "ST2"] },
  ]),
  def(6, "4-4-2 Attacking", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 50, roles: ["LW", "AM1", "AM2", "RW"] },
    { x: 70, roles: ["ST1", "ST2"] },
  ]),
  def(7, "4-3-3", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 45, roles: ["DM", "AM1", "AM2"] },
    { x: 68, roles: ["LW", "ST", "RW"] },
  ]),
  def(8, "4-3-3 Holding", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 38, roles: ["DM1", "DM2"] },
    { x: 50, roles: ["AM"] },
    { x: 68, roles: ["LW", "ST", "RW"] },
  ]),
  def(9, "3-5-2", [
    { x: 25, roles: ["CB1", "CB2", "CB3"] },
    { x: 45, roles: ["AM1", "DM1", "AM2", "DM2", "AM3"] },
    { x: 68, roles: ["ST1", "ST2"] },
  ]),
  def(10, "3-4-3", [
    { x: 25, roles: ["CB1", "CB2", "CB3"] },
    { x: 45, roles: ["AM1", "DM1", "DM2", "AM2"] },
    { x: 68, roles: ["LW", "ST", "RW"] },
  ]),
  def(11, "4-2-3-1", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 38, roles: ["DM1", "DM2"] },
    { x: 54, roles: ["LW", "AM", "RW"] },
    { x: 70, roles: ["ST"] },
  ]),
  def(12, "4-2-3-1 Wide", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 36, roles: ["DM1", "DM2"] },
    { x: 54, roles: ["AM1", "AM2", "AM3"] },
    { x: 70, roles: ["ST"] },
  ]),
  def(13, "4-3-1-2", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 38, roles: ["DM1", "DM2", "DM3"] },
    { x: 52, roles: ["AM"] },
    { x: 66, roles: ["ST1", "ST2"] },
  ]),
  def(14, "4-1-3-2", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 34, roles: ["DM"] },
    { x: 50, roles: ["AM1", "AM2", "AM3"] },
    { x: 66, roles: ["ST1", "ST2"] },
  ]),
  def(15, "3-4-1-2", [
    { x: 25, roles: ["CB1", "CB2", "CB3"] },
    { x: 40, roles: ["AM1", "DM1", "DM2", "AM2"] },
    { x: 52, roles: ["AM3"] },
    { x: 66, roles: ["ST1", "ST2"] },
  ]),
  def(16, "3-3-2-2", [
    { x: 25, roles: ["CB1", "CB2", "CB3"] },
    { x: 40, roles: ["DM1", "AM1", "DM2"] },
    { x: 52, roles: ["AM2", "AM3"] },
    { x: 66, roles: ["ST1", "ST2"] },
  ]),
  def(17, "4-2-4", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 40, roles: ["DM1", "DM2"] },
    { x: 62, roles: ["LW", "ST1", "ST2", "RW"] },
  ]),
  def(18, "4-3-2-1", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 38, roles: ["DM1", "DM2", "DM3"] },
    { x: 52, roles: ["AM1", "AM2"] },
    { x: 66, roles: ["ST"] },
  ]),
  def(19, "4-2-2-2", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 38, roles: ["DM1", "DM2"] },
    { x: 52, roles: ["AM1", "AM2"] },
    { x: 66, roles: ["ST1", "ST2"] },
  ]),
  def(20, "3-5-1-1", [
    { x: 25, roles: ["CB1", "CB2", "CB3"] },
    { x: 42, roles: ["AM1", "DM1", "DM2", "DM3", "AM2"] },
    { x: 54, roles: ["AM3"] },
    { x: 68, roles: ["ST"] },
  ]),
  def(21, "4-1-4-1", [
    { x: 25, roles: ["LB", "CB1", "CB2", "RB"] },
    { x: 34, roles: ["DM1"] },
    { x: 46, roles: ["AM1", "DM2", "DM3", "AM2"] },
    { x: 66, roles: ["ST"] },
  ]),
  def(22, "5-2-3", [
    { x: 25, roles: ["LB", "CB1", "CB2", "CB3", "RB"] },
    { x: 40, roles: ["DM1", "DM2"] },
    { x: 62, roles: ["LW", "ST", "RW"] },
  ]),
];

// §4.3: every one of the nine deployed roles must occur somewhere in the
// catalog, otherwise a configured role kernel or penalty row is unreachable.
{
  const covered = new Set(FORMATIONS.flatMap((f) => f.slots.map((s) => s.role)));
  const missing = DEPLOYED_ROLES.filter((role) => !covered.has(role));
  if (missing.length > 0) throw new Error(`Formation catalog never uses deployed role(s): ${missing.join(", ")}`);
}

const byId = new Map(FORMATIONS.map((f) => [f.id, f]));
export function formationById(id: number): FormationDefinition | undefined {
  return byId.get(id);
}
export function formationOptions(): { id: number; name: string }[] {
  return FORMATIONS.map((f) => ({ id: f.id, name: f.name }));
}

export function formationSimilarity(a: FormationDefinition, b: FormationDefinition): number {
  const tokens = (f: FormationDefinition) => f.slots.map((s) => `${s.role}:${s.lane}:${s.line}`);
  const aTokens = tokens(a);
  const bTokens = tokens(b);
  const count = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const t of arr) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const aCount = count(aTokens);
  const bCount = count(bTokens);
  let inter = 0;
  let union = 0;
  const keys = new Set([...aCount.keys(), ...bCount.keys()]);
  for (const k of keys) {
    const av = aCount.get(k) ?? 0;
    const bv = bCount.get(k) ?? 0;
    inter += Math.min(av, bv);
    union += Math.max(av, bv);
  }
  return union === 0 ? 0 : inter / union;
}
