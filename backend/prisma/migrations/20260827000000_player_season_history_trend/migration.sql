-- End-of-season overall/value snapshots for the player-trend charts.
--
-- Nullable on purpose: rows predating this migration have no snapshot, and the
-- world is reset on rollout so there is no production data to backfill. The
-- domain writes both columns explicitly at season rollover (upsert), so no
-- default is needed.

ALTER TABLE "PlayerSeasonHistory" ADD COLUMN "overall" INTEGER;
ALTER TABLE "PlayerSeasonHistory" ADD COLUMN "value" INTEGER;
