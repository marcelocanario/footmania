import type { Club, World } from "./types";
import type { Prisma } from "@prisma/client";
import { deserializeClubKits, serializeClubKits } from "./kits";
import type { HumanClubOptions } from "./worldgen";

/**
 * Club identity preservation across world resets.
 *
 * When an admin resets the world with `keepIdentity`, every human club is
 * snapshotted into a `ClubIdentityArchive` row (a table outside the Save
 * scope, so it survives the delete+recreate). On the owner's next `/mp/join`
 * the snapshot re-applies the preserved identity instead of the wizard
 * payload, and the row is consumed (deleted) once placement succeeds.
 *
 * Only identity is stored — nothing game-progress related (squad, finances,
 * trophies, history). Friendships already live outside the Save cascade, so
 * they need no archiving.
 */

/** Prisma create payload for one archive row (identity subset of a club). */
export function archiveRowForClub(club: Club): Prisma.ClubIdentityArchiveCreateInput {
  const customLogo = club.customLogo ?? null;
  return {
    user: { connect: { id: club.ownerUserId! } },
    name: club.name,
    shortName: club.shortName,
    country: club.country,
    stadiumName: club.stadiumName,
    coachName: club.coachName,
    kitJson: serializeClubKits(club.kits),
    primaryColor: club.primaryColor,
    secondaryColor: club.secondaryColor,
    logoVariant: club.logoVariant ?? 0,
    customLogoMime: customLogo?.mime ?? null,
    customLogoData: customLogo?.data ?? null,
    customLogoStatus: customLogo?.status ?? "ACTIVE",
    preferredHoursJson: club.preferredHours ? JSON.stringify(club.preferredHours) : null,
    friendGroupingOptIn: club.friendGroupingOptIn !== false,
  };
}

/**
 * Archive rows for every ACTIVE or DORMANT human-owned club in the world.
 *
 * Identity preservation covers clubs that belong to a human manager and could
 * reasonably come back: ACTIVE clubs (competing now) and DORMANT clubs (frozen
 * but owned — the reset destroys the world, so a returning manager's next
 * join restores the identity instead of starting anonymous). PROVISIONAL clubs
 * are not archived: their owners are already mid-join for the coming season
 * and flow through the same fresh join path.
 */
export function archiveRowsFromWorld(world: World): Prisma.ClubIdentityArchiveCreateManyInput[] {
  return world.clubs
    .filter((club) => club.ownerUserId !== null && (club.competitionState === "ACTIVE" || club.competitionState === "DORMANT"))
    .map((club) => {
      const row = archiveRowForClub(club);
      const { user: _user, ...rest } = row;
      return { userId: club.ownerUserId!, ...rest } as Prisma.ClubIdentityArchiveCreateManyInput;
    });
}

/** A decoded archive row, ready to be applied at join time. */
export interface ResolvedArchive {
  name: string;
  shortName: string;
  country: string;
  stadiumName: string;
  coachName: string;
  kits: import("./kits").ClubKits | null;
  primaryColor: string;
  secondaryColor: string;
  logoVariant: number;
  customLogo: { mime: string; data: string; status: string } | null;
  preferredHours: number[] | null;
  friendGroupingOptIn: boolean;
}

/** Decode a stored archive row (JSON columns back to structured values). */
export function resolveArchiveRow(row: {
  name: string;
  shortName: string;
  country: string;
  stadiumName: string;
  coachName: string;
  kitJson: string | null;
  primaryColor: string;
  secondaryColor: string;
  logoVariant: number;
  customLogoMime: string | null;
  customLogoData: string | null;
  customLogoStatus: string | null;
  preferredHoursJson: string | null;
  friendGroupingOptIn: boolean;
}): ResolvedArchive {
  const kits = deserializeClubKits(row.kitJson);
  return {
    name: row.name,
    shortName: row.shortName,
    country: row.country,
    stadiumName: row.stadiumName,
    coachName: row.coachName,
    kits,
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    logoVariant: row.logoVariant ?? 0,
    customLogo:
      row.customLogoData != null && row.customLogoData.length > 0
        ? { mime: row.customLogoMime ?? "image/png", data: row.customLogoData, status: row.customLogoStatus ?? "ACTIVE" }
        : null,
    preferredHours: row.preferredHoursJson ? JSON.parse(row.preferredHoursJson) : null,
    friendGroupingOptIn: row.friendGroupingOptIn !== false,
  };
}

/**
 * Merge an archived identity over the wizard payload for `createHumanClub`.
 * The archive is authoritative for every identity field it covers; the wizard
 * payload remains the fallback for anything not archived (it never is today,
 * but staying schema-shaped keeps callers simple).
 */
export function applyArchivedIdentity(archive: ResolvedArchive, wizard: HumanClubOptions): HumanClubOptions {
  return {
    ...wizard,
    userId: wizard.userId,
    clubName: archive.name,
    country: archive.country,
    primaryColor: archive.primaryColor,
    secondaryColor: archive.secondaryColor,
    kits: archive.kits,
    stadiumName: archive.stadiumName,
    coachName: archive.coachName,
    preferredHours: archive.preferredHours ?? undefined,
    friendGroupingOptIn: archive.friendGroupingOptIn,
  };
}
