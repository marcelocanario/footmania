/** Cumulative permissions: admins have pro + admin. */
export function hasPro(user: { isPro?: boolean; isAdmin?: boolean } | null | undefined): boolean {
  if (!user) return false;
  return Boolean(user.isPro || user.isAdmin);
}

export function isBanned(user: { bannedAt?: Date | string | null } | null | undefined): boolean {
  return Boolean(user?.bannedAt);
}
