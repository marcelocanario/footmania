-- Match MVP (best performer on the winning team).
--
-- * Match.mvpPlayerId: the player named MVP at finalization (nullable; null for
--   matches finished before the feature or matches with no eligible player).
-- * Player.careerMvps / Player.seasonMvps: lifetime and season MVP counts,
--   credited at match finalization from the authoritative MVP award.
-- * PlayerSeasonHistory.mvps: season MVP count snapshot at rollover.
--
-- No backfill: the world is reset on rollout, so pre-feature matches have no
-- MVP award and players start at zero.

ALTER TABLE "Match" ADD COLUMN "mvpPlayerId" INTEGER;
ALTER TABLE "Player" ADD COLUMN "careerMvps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "seasonMvps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlayerSeasonHistory" ADD COLUMN "mvps" INTEGER NOT NULL DEFAULT 0;
