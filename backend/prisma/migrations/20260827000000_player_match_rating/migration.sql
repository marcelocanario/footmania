-- Player match performance ratings (plan §16) and season-frozen positional
-- calibration (plan §10).
--
-- No backfill: the world is reset on rollout, so pre-feature matches have no
-- ratings and players start with an empty history.

CREATE TABLE "PlayerMatchRating" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "matchId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "tier" INTEGER NOT NULL,
    "primaryRole" TEXT NOT NULL,
    "minutesPlayed" INTEGER NOT NULL,
    "rawImpact" DOUBLE PRECISION NOT NULL,
    "rawVariance" DOUBLE PRECISION NOT NULL,
    "rawZ" DOUBLE PRECISION NOT NULL,
    "balancedZ" DOUBLE PRECISION NOT NULL,
    "ratingExact" DOUBLE PRECISION,
    "shootingImpact" DOUBLE PRECISION NOT NULL,
    "passingImpact" DOUBLE PRECISION NOT NULL,
    "dribblingImpact" DOUBLE PRECISION NOT NULL,
    "defendingImpact" DOUBLE PRECISION NOT NULL,
    "goalkeepingImpact" DOUBLE PRECISION NOT NULL,
    "ratingModelVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerMatchRating_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoleCalibration" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "ratingModelVersion" INTEGER NOT NULL,
    "zRawsJson" TEXT NOT NULL,

    CONSTRAINT "RoleCalibration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlayerMatchRating_saveId_matchId_playerId_key" ON "PlayerMatchRating"("saveId", "matchId", "playerId");
CREATE INDEX "PlayerMatchRating_saveId_playerId_createdAt_idx" ON "PlayerMatchRating"("saveId", "playerId", "createdAt");
CREATE INDEX "PlayerMatchRating_saveId_playerId_seasonId_idx" ON "PlayerMatchRating"("saveId", "playerId", "seasonId");
CREATE INDEX "PlayerMatchRating_saveId_seasonId_primaryRole_ratingMod_idx" ON "PlayerMatchRating"("saveId", "seasonId", "primaryRole", "ratingModelVersion");
CREATE UNIQUE INDEX "RoleCalibration_saveId_seasonId_role_ratingModelVersio_key" ON "RoleCalibration"("saveId", "seasonId", "role", "ratingModelVersion");
CREATE INDEX "RoleCalibration_saveId_seasonId_idx" ON "RoleCalibration"("saveId", "seasonId");

ALTER TABLE "PlayerMatchRating" ADD CONSTRAINT "PlayerMatchRating_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleCalibration" ADD CONSTRAINT "RoleCalibration_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;
