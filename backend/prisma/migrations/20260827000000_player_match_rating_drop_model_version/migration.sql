-- Drop the single-model rating-version column: only one rating model exists,
-- so versioning rows by model adds no information. Drop the versioned indexes
-- FIRST (Postgres auto-drops them when their column is dropped, which would
-- otherwise make the later DROP INDEX fail).

DROP INDEX IF EXISTS "PlayerMatchRating_saveId_seasonId_primaryRole_ratingMod_idx";
DROP INDEX IF EXISTS "RoleCalibration_saveId_seasonId_role_ratingModelVersio_key";

ALTER TABLE "PlayerMatchRating" DROP COLUMN "ratingModelVersion";
ALTER TABLE "RoleCalibration" DROP COLUMN "ratingModelVersion";

CREATE INDEX "PlayerMatchRating_saveId_seasonId_primaryRole_idx" ON "PlayerMatchRating"("saveId", "seasonId", "primaryRole");
CREATE UNIQUE INDEX "RoleCalibration_saveId_seasonId_role_key" ON "RoleCalibration"("saveId", "seasonId", "role");
