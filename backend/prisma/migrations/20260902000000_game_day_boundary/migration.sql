-- Boundary-aligned game-day grid reference on the durable clock row. The
-- scheduler derives the day-advance trigger and the pending GAME_DAY_ADVANCE
-- row from mp.lastBoundaryAt, mirrored here by ensureGameClock and the resume
-- shift. Nullable: pre-migration saves backfill on first load.
ALTER TABLE "GameClock" ADD COLUMN "lastBoundaryAt" TIMESTAMP(3);