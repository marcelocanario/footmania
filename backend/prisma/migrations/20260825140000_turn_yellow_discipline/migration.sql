-- Per-league-turn yellow-card accumulation.
--
-- turnYellows counts bookings inside the current league turn; yellowsTurnKey
-- records which turn (seasonNumber * league.turns + floor(round/(teams-1)))
-- they belong to so stale counters expire at every turn boundary. The existing
-- "yellows" column keeps its meaning as the season total written into season
-- history; only its reset-at-three behavior is retired in favor of the new
-- per-turn limit.

-- Added with defaults so the columns can be NOT NULL on a populated table, then
-- stripped: the domain always supplies these explicitly, so a silent default
-- would mask a persistence bug rather than help.
ALTER TABLE "Player" ADD COLUMN "turnYellows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "yellowsTurnKey" INTEGER;

ALTER TABLE "Player" ALTER COLUMN "turnYellows" DROP DEFAULT;
