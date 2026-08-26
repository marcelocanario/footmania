-- Club identity preserved across a world reset (not save-scoped).
-- Snapshots human club identity (name, colors, kits, crest, stadium, coach,
-- preferred match hours, friend-grouping opt-in) so a reset with identity
-- preservation can restore it on the owner's next join. The row is consumed
-- on successful placement. Cascades with the owning user account.
CREATE TABLE "ClubIdentityArchive" (
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "stadiumName" TEXT NOT NULL,
    "coachName" TEXT NOT NULL,
    "kitJson" TEXT,
    "primaryColor" TEXT NOT NULL,
    "secondaryColor" TEXT NOT NULL,
    "logoVariant" INTEGER NOT NULL DEFAULT 0,
    "customLogoMime" TEXT,
    "customLogoData" TEXT,
    "customLogoStatus" TEXT,
    "preferredHoursJson" TEXT,
    "friendGroupingOptIn" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubIdentityArchive_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "ClubIdentityArchive" ADD CONSTRAINT "ClubIdentityArchive_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
