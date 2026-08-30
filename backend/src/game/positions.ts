export const NATURAL_POSITIONS = [
  "GK", "LB", "RB", "CB", "DM", "AM", "LW", "RW", "ST",
] as const;

export type NaturalPosition = (typeof NATURAL_POSITIONS)[number];

export const POSITION_GROUPS = ["GK", "FB", "CB", "MF", "FW"] as const;
export type PositionGroup = (typeof POSITION_GROUPS)[number];

export const RATING_ROLES = ["GK", "FB", "CB", "MID", "FWD"] as const;
export type RatingRole = (typeof RATING_ROLES)[number];

/**
 * Deployed roles are the roles a formation slot can demand. They now coincide
 * with the nine natural positions: there are no tactical sub-roles (SW/LM/RM
 * were removed) that no player is ever born with — every slot is a position a
 * player can actually occupy naturally, so any slot can be filled penalty-free
 * by a player of the matching natural position.
 */
export const DEPLOYED_ROLES = NATURAL_POSITIONS;
export type DeployedRole = (typeof DEPLOYED_ROLES)[number];

const POSITION_GROUP_MAP: Record<NaturalPosition, PositionGroup> = {
  GK: "GK",
  LB: "FB",
  RB: "FB",
  CB: "CB",
  DM: "MF",
  AM: "MF",
  LW: "FW",
  RW: "FW",
  ST: "FW",
};

const RATING_ROLE_MAP: Record<NaturalPosition, RatingRole> = {
  GK: "GK",
  LB: "FB",
  RB: "FB",
  CB: "CB",
  DM: "MID",
  AM: "MID",
  LW: "FWD",
  RW: "FWD",
  ST: "FWD",
};

const DEFAULT_ROLE_MAP: Record<NaturalPosition, DeployedRole> = {
  GK: "GK",
  LB: "LB",
  RB: "RB",
  CB: "CB",
  DM: "DM",
  AM: "AM",
  LW: "LW",
  RW: "RW",
  ST: "ST",
};

// Non-sequential on purpose: codes 0..4 preserve legacy numeric positions
// (GK/FB/CB/MF/FW) for migration readability (ST reuses 4), new natural
// positions are appended at 5..8. Do not reorder — persisted player rows
// and migration logic depend on this mapping.
const POSITION_CODES: Record<NaturalPosition, number> = {
  GK: 0,
  LB: 1,
  CB: 2,
  DM: 3,
  ST: 4,
  RB: 5,
  AM: 6,
  LW: 7,
  RW: 8,
};

const CODE_TO_POSITION: Record<number, NaturalPosition> = {
  0: "GK",
  1: "LB",
  2: "CB",
  3: "DM",
  4: "ST",
  5: "RB",
  6: "AM",
  7: "LW",
  8: "RW",
};

const FULL_NAMES: Record<NaturalPosition, string> = {
  GK: "Goalkeeper",
  LB: "Left back",
  RB: "Right back",
  CB: "Center back",
  DM: "Defensive midfielder",
  AM: "Attacking midfielder",
  LW: "Left winger",
  RW: "Right winger",
  ST: "Striker",
};

export const NATURAL_POSITION_ORDER: NaturalPosition[] = ["GK", "LB", "RB", "CB", "DM", "AM", "LW", "RW", "ST"];

export function positionGroup(pos: NaturalPosition): PositionGroup {
  return POSITION_GROUP_MAP[pos];
}

export function ratingRoleForPosition(pos: NaturalPosition): RatingRole {
  return RATING_ROLE_MAP[pos];
}

export function isGoalkeeper(pos: NaturalPosition): boolean {
  return pos === "GK";
}

export function isOutfielder(pos: NaturalPosition): boolean {
  return pos !== "GK";
}

export function naturalDefaultRole(pos: NaturalPosition): DeployedRole {
  return DEFAULT_ROLE_MAP[pos];
}

export function positionToCode(pos: NaturalPosition): number {
  return POSITION_CODES[pos];
}

export function positionFromV2Code(code: number): NaturalPosition {
  const pos = CODE_TO_POSITION[code];
  if (!pos) throw new Error(`Invalid position code ${code}`);
  return pos;
}

export function positionName(pos: NaturalPosition): string {
  return FULL_NAMES[pos];
}

/**
 * One natural position standing in for a whole broad group, for the models that
 * remain broad-group based (§13.2 retirement/value survival, population
 * equilibrium). Any member of the group would do — they share every
 * group-derived formula — but pairing a group weight with an arbitrary index
 * into the nine-position array silently mismatches the two.
 */
const GROUP_REPRESENTATIVE: Record<PositionGroup, NaturalPosition> = {
  GK: "GK",
  FB: "LB",
  CB: "CB",
  MF: "DM",
  FW: "ST",
};

export function groupRepresentative(group: PositionGroup): NaturalPosition {
  return GROUP_REPRESENTATIVE[group];
}

export function legacyPositionGroup(code: number): PositionGroup {
  const map: Record<number, PositionGroup> = { 0: "GK", 1: "FB", 2: "CB", 3: "MF", 4: "FW" };
  const g = map[code];
  if (!g) throw new Error(`Invalid legacy position code ${code}`);
  return g;
}
