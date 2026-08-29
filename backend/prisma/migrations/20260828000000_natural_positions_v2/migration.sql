-- Natural positions V2 (§14): rename legacy vel/arm skill columns, drop the
-- ambiguous side/tacPos columns, and add the position-model version marker.
-- The application migration (scripts/migrate-natural-positions.ts) rewrites
-- Player.position codes 0..4 -> the nine natural positions inside its own
-- locked transaction, so this SQL only does the structural rename/removal.

-- Skill column renames (values are copied by the column rename itself).
ALTER TABLE "Player" RENAME COLUMN "skillVel" TO "skillPace";
ALTER TABLE "Player" RENAME COLUMN "skillArm" TO "skillPlaymaking";

-- Remove the global deployed-position bookkeeping from Player.
ALTER TABLE "Player" DROP COLUMN "side";
ALTER TABLE "Player" DROP COLUMN "tacPos";

-- Position-model version marker. DEFAULT 1 on purpose: every row that already
-- exists when this migration runs still holds legacy GK/FB/CB/MF/FW codes and
-- MUST be seen as v1 so scripts/migrate-natural-positions.ts converts it.
-- New worlds write 2 explicitly in ensureGlobalSave.
ALTER TABLE "Save" ADD COLUMN "positionModelVersion" INTEGER NOT NULL DEFAULT 1;
