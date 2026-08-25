-- Career-shaped player model.
--
-- Replaces the old development profile (decline age + development rate +
-- volatility) and the separate mutable potential ceiling with the five hidden
-- career-profile attributes and the two consumed-budget counters. There is
-- deliberately no migration of the old values: potential, growth tier and
-- development rate were independent capacity authorities with no equivalent in
-- the new single-budget model, and the world is reset when this lands.

ALTER TABLE "Player" DROP COLUMN "potential";
ALTER TABLE "Player" DROP COLUMN "growthAcc";
ALTER TABLE "Player" DROP COLUMN "potentialAcc";
ALTER TABLE "Player" DROP COLUMN "declineStartAge";
ALTER TABLE "Player" DROP COLUMN "developmentRate";
ALTER TABLE "Player" DROP COLUMN "developmentVolatility";

-- Added with defaults so the columns can be NOT NULL on a populated table, then
-- stripped: the domain always supplies these explicitly, so a silent default
-- would mask a persistence bug rather than help.
ALTER TABLE "Player" ADD COLUMN "careerGrowthConsumed" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "careerDeclineConsumed" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "growthPotential" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE "Player" ADD COLUMN "growthSpeed" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE "Player" ADD COLUMN "peakAge" INTEGER NOT NULL DEFAULT 27;
ALTER TABLE "Player" ADD COLUMN "declinePotential" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE "Player" ADD COLUMN "declineSpeed" DOUBLE PRECISION NOT NULL DEFAULT 0.5;

ALTER TABLE "Player" ALTER COLUMN "careerGrowthConsumed" DROP DEFAULT;
ALTER TABLE "Player" ALTER COLUMN "careerDeclineConsumed" DROP DEFAULT;
ALTER TABLE "Player" ALTER COLUMN "growthPotential" DROP DEFAULT;
ALTER TABLE "Player" ALTER COLUMN "growthSpeed" DROP DEFAULT;
ALTER TABLE "Player" ALTER COLUMN "peakAge" DROP DEFAULT;
ALTER TABLE "Player" ALTER COLUMN "declinePotential" DROP DEFAULT;
ALTER TABLE "Player" ALTER COLUMN "declineSpeed" DROP DEFAULT;
