/** Cumulative permissions: admins have pro + admin. */
export function hasPro(user: { isPro?: boolean; isAdmin?: boolean } | null | undefined): boolean {
  if (!user) return false;
  return Boolean(user.isPro || user.isAdmin);
}

/**
 * Server-side authorization for viewing a player's performance ratings
 * (plan §24). True when any of: viewer is admin; viewer has Pro; viewer manages
 * the player's owning club; viewer has the player on loan; viewer owns a player
 * currently loaned out; the player is unowned/free agent.
 */
export function canViewPlayerPerformance(
  viewer: { isPro?: boolean; isAdmin?: boolean } | null | undefined,
  player: { id: number; clubId: number | null; loanId: number | null },
  context: {
    viewerClubId: number | null;
    loans: { playerId: number; fromClubId: number; toClubId: number | null; recalled: boolean }[];
  },
): boolean {
  if (!viewer) return false;
  if (viewer.isAdmin || hasPro(viewer)) return true;
  if (player.clubId === null) return true; // free agent
  if (context.viewerClubId !== null && player.clubId === context.viewerClubId) return true;
  // Active loan involvement (either direction).
  return context.loans.some(
    (l) => !l.recalled && l.playerId === player.id && (l.fromClubId === context.viewerClubId || l.toClubId === context.viewerClubId),
  );
}

export function isBanned(user: { bannedAt?: Date | string | null } | null | undefined): boolean {
  return Boolean(user?.bannedAt);
}
