-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "timezone" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isPro" BOOLEAN NOT NULL DEFAULT false,
    "bannedAt" TIMESTAMP(3),
    "banReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "token" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "Save" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "humanClubId" INTEGER,
    "seed" INTEGER NOT NULL DEFAULT 0,
    "rngState" BIGINT NOT NULL DEFAULT 0,
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "globalKey" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "mpStateJson" TEXT,
    "seasonSummaryJson" TEXT,
    "seasonHistoryJson" TEXT,
    "pendingEventsJson" TEXT,
    "pendingMatchIdsJson" TEXT,
    "generationEventsJson" TEXT,
    "financialInterventionsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Save_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friendship" (
    "id" SERIAL NOT NULL,
    "userAId" INTEGER NOT NULL,
    "userBId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "token" TEXT NOT NULL,
    "inviterUserId" INTEGER NOT NULL,
    "inviteeUserId" INTEGER,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "GameClock" (
    "id" TEXT NOT NULL,
    "saveId" INTEGER NOT NULL,
    "absoluteGameDay" INTEGER NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "seasonDayIndex" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "lastAdvancedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GameClock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledEvent" (
    "id" TEXT NOT NULL,
    "saveId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "timeBasis" TEXT NOT NULL,
    "dueAbsoluteGameDay" INTEGER,
    "dueAt" TIMESTAMP(3),
    "phase" TEXT,
    "priority" INTEGER NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "executionSource" TEXT NOT NULL DEFAULT 'AUTOMATIC',
    "executedByAdminUserId" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ScheduledEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSchedulerAudit" (
    "id" TEXT NOT NULL,
    "saveId" INTEGER NOT NULL,
    "adminUserId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "beforeJson" TEXT NOT NULL,
    "afterJson" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSchedulerAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Club" (
    "id" INTEGER NOT NULL,
    "saveId" INTEGER NOT NULL,
    "ownerUserId" INTEGER,
    "timezone" TEXT,
    "competitionState" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastMeaningfulActivityAt" BIGINT,
    "abandonmentEligibleAt" BIGINT,
    "liveMatchAt" BIGINT,
    "preferredHoursJson" TEXT,
    "friendGroupingOptIn" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "highestDivision" INTEGER NOT NULL DEFAULT 1,
    "cash" INTEGER NOT NULL,
    "stadiumName" TEXT NOT NULL,
    "primaryColor" TEXT NOT NULL,
    "secondaryColor" TEXT NOT NULL,
    "kitJson" TEXT,
    "logoVariant" INTEGER NOT NULL DEFAULT 0,
    "customLogoMime" TEXT,
    "customLogoData" TEXT,
    "customLogoStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "automationPresetsJson" TEXT,
    "coachName" TEXT NOT NULL,
    "coachNameChangedSeasonKey" TEXT,
    "isHuman" BOOLEAN NOT NULL,
    "captainId" INTEGER,
    "penaltyTakerId" INTEGER,
    "tacticsFormation" INTEGER NOT NULL,
    "tacticsStyle" INTEGER NOT NULL,
    "tacticsPressing" INTEGER NOT NULL,
    "tacticsDirection" INTEGER NOT NULL,
    "tacticsFamiliarityJson" TEXT,
    "trainingFocus" TEXT NOT NULL DEFAULT 'assistant',
    "savedLineupJson" TEXT,
    "eloRating" DOUBLE PRECISION NOT NULL DEFAULT 1500,
    "eloRatedMatches" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("saveId","id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" INTEGER NOT NULL,
    "saveId" INTEGER NOT NULL,
    "clubId" INTEGER,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "side" INTEGER NOT NULL,
    "overall" INTEGER NOT NULL,
    "potential" INTEGER NOT NULL,
    "energy" INTEGER NOT NULL,
    "recentLoad" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "salary" INTEGER NOT NULL,
    "payrollPaidThroughDay" INTEGER NOT NULL DEFAULT 0,
    "payrollPaidAmount" INTEGER NOT NULL DEFAULT 0,
    "payrollPeriodStartDay" INTEGER NOT NULL DEFAULT 0,
    "value" INTEGER NOT NULL,
    "releaseClause" INTEGER NOT NULL,
    "injuryDays" INTEGER NOT NULL,
    "injuryUntilAbsoluteGameDay" INTEGER,
    "injuryInitialGameDays" INTEGER,
    "injuryEquivalentRealDays" DOUBLE PRECISION,
    "injuryCause" TEXT,
    "contractDays" INTEGER NOT NULL,
    "isYouth" BOOLEAN NOT NULL,
    "starter" BOOLEAN NOT NULL,
    "growthAcc" DOUBLE PRECISION NOT NULL,
    "potentialAcc" DOUBLE PRECISION NOT NULL,
    "careerGoals" INTEGER NOT NULL,
    "careerAssists" INTEGER NOT NULL,
    "seasonGoals" INTEGER NOT NULL,
    "seasonAssists" INTEGER NOT NULL,
    "seasonAppearances" INTEGER NOT NULL DEFAULT 0,
    "yellows" INTEGER NOT NULL,
    "reds" INTEGER NOT NULL,
    "tacPos" INTEGER NOT NULL,
    "squadNumber" INTEGER,
    "onSale" BOOLEAN NOT NULL,
    "suspendedGames" INTEGER NOT NULL,
    "loanId" INTEGER,
    "skillGol" INTEGER NOT NULL,
    "skillVel" INTEGER NOT NULL,
    "skillTec" INTEGER NOT NULL,
    "skillPas" INTEGER NOT NULL,
    "skillDes" INTEGER NOT NULL,
    "skillArm" INTEGER NOT NULL,
    "skillFin" INTEGER NOT NULL,
    "nickname" TEXT,
    "skillAccJson" TEXT NOT NULL,
    "declineStartAge" DOUBLE PRECISION,
    "developmentRate" DOUBLE PRECISION,
    "developmentVolatility" DOUBLE PRECISION,
    "recentMinutesJson" TEXT,
    "generatedClubId" INTEGER,
    "generatedDivision" INTEGER,
    "generatedSeasonId" INTEGER,
    "generationType" TEXT,
    "generatedClubHighestDivision" INTEGER,
    "rawZ" DOUBLE PRECISION,
    "financialInterventionGeneratedSeasonId" INTEGER,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("saveId","id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" INTEGER NOT NULL,
    "saveId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "fromClubId" INTEGER NOT NULL,
    "toClubId" INTEGER,
    "startDay" INTEGER NOT NULL,
    "endDay" INTEGER NOT NULL,
    "recalled" BOOLEAN NOT NULL,
    "feeAmount" INTEGER NOT NULL DEFAULT 0,
    "listedAt" BIGINT NOT NULL,
    "claimableAt" BIGINT NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("saveId","id")
);

-- CreateTable
CREATE TABLE "Competition" (
    "id" INTEGER NOT NULL,
    "saveId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "seasonId" INTEGER,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "groupIndex" INTEGER NOT NULL DEFAULT 0,
    "referenceTimezone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "configJson" TEXT NOT NULL,
    "winnersJson" TEXT NOT NULL,
    "knockoutsJson" TEXT NOT NULL,
    "groupStandingsJson" TEXT NOT NULL,

    CONSTRAINT "Competition_pkey" PRIMARY KEY ("saveId","id")
);

-- CreateTable
CREATE TABLE "StandingsRow" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "competitionId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "played" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "draws" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "goalsFor" INTEGER NOT NULL,
    "goalsAgainst" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "groupName" TEXT,

    CONSTRAINT "StandingsRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fixture" (
    "id" INTEGER NOT NULL,
    "saveId" INTEGER NOT NULL,
    "competitionId" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "homeClubId" INTEGER NOT NULL,
    "awayClubId" INTEGER NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "played" BOOLEAN NOT NULL,
    "leg" INTEGER,
    "tie" INTEGER,
    "kickoffAt" BIGINT,
    "scheduledSeasonDayIndex" INTEGER,
    "homeClubNameSnapshot" TEXT,
    "awayClubNameSnapshot" TEXT,

    CONSTRAINT "Fixture_pkey" PRIMARY KEY ("saveId","id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" INTEGER NOT NULL,
    "saveId" INTEGER NOT NULL,
    "fixtureId" INTEGER NOT NULL,
    "competitionId" INTEGER NOT NULL,
    "homeClubId" INTEGER NOT NULL,
    "awayClubId" INTEGER NOT NULL,
    "homeScore" INTEGER NOT NULL,
    "awayScore" INTEGER NOT NULL,
    "penaltyWinnerId" INTEGER,
    "penaltyScoreJson" TEXT,
    "extraTime" BOOLEAN NOT NULL,
    "scheduledAt" BIGINT,
    "homeWasHuman" BOOLEAN NOT NULL DEFAULT false,
    "awayWasHuman" BOOLEAN NOT NULL DEFAULT false,
    "eloProcessed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("saveId","id")
);

-- CreateTable
CREATE TABLE "ClubEloEvent" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "matchId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "opponentClubId" INTEGER NOT NULL,
    "ratingBefore" DOUBLE PRECISION NOT NULL,
    "ratingAfter" DOUBLE PRECISION NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "expectedScore" DOUBLE PRECISION NOT NULL,
    "actualScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubEloEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchStat" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "matchId" INTEGER NOT NULL,
    "statsJson" TEXT NOT NULL,

    CONSTRAINT "MatchStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchEvent" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "matchId" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "half" INTEGER NOT NULL,
    "type" INTEGER NOT NULL,
    "subtype" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "playerId" INTEGER,
    "player2Id" INTEGER,
    "goalType" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsItem" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "clubId" INTEGER,
    "seasonId" INTEGER,
    "subject" TEXT,
    "headline" TEXT,
    "entriesJson" TEXT,
    "recipientClubId" INTEGER,

    CONSTRAINT "NewsItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "code" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trophy" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "competitionName" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "Trophy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonAward" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "season" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "competitionId" INTEGER,
    "playerId" INTEGER,
    "clubId" INTEGER,
    "playerNameSnapshot" TEXT,
    "detail" TEXT,

    CONSTRAINT "SeasonAward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerRecord" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "holderName" TEXT NOT NULL,

    CONSTRAINT "CareerRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveMatch" (
    "saveId" INTEGER NOT NULL,
    "matchId" INTEGER NOT NULL,
    "homeClubId" INTEGER,
    "awayClubId" INTEGER,
    "stateJson" TEXT NOT NULL,

    CONSTRAINT "LiveMatch_pkey" PRIMARY KEY ("saveId","matchId")
);

-- CreateTable
CREATE TABLE "TransferAuction" (
    "id" INTEGER NOT NULL,
    "saveId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "sellerClubId" INTEGER NOT NULL,
    "playerValueAtListing" INTEGER NOT NULL,
    "openingPrice" INTEGER NOT NULL,
    "bidIncrement" INTEGER NOT NULL,
    "sellerDivisionAtListing" INTEGER NOT NULL,
    "totalDivisionsAtListing" INTEGER NOT NULL,
    "salaryBaselineAtListing" INTEGER,
    "playerOverallAtListing" INTEGER,
    "playerAgeAtListing" INTEGER,
    "currentPrice" INTEGER NOT NULL,
    "leadingClubId" INTEGER,
    "createdAt" BIGINT NOT NULL,
    "deadline" BIGINT NOT NULL,
    "originalDeadline" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "completedAt" BIGINT,
    "winningClubId" INTEGER,
    "finalPrice" INTEGER,
    "cancelledAt" BIGINT,
    "softClosed" BOOLEAN NOT NULL,
    "deadlineVersion" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TransferAuction_pkey" PRIMARY KEY ("saveId","id")
);

-- CreateTable
CREATE TABLE "MarketBid" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "marketType" TEXT NOT NULL,
    "listingId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "maxBid" INTEGER NOT NULL,
    "capMultiplierAtSubmission" DOUBLE PRECISION,
    "maximumAllowedByRuleAtSubmission" INTEGER,
    "buyerDivisionAtSubmission" INTEGER,
    "contractSeasons" INTEGER,
    "contractSalary" INTEGER,
    "contractDemandAtSubmission" INTEGER,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "initialPriorityAt" BIGINT NOT NULL,

    CONSTRAINT "MarketBid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreeAgentListing" (
    "id" INTEGER NOT NULL,
    "saveId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "playerValueAtListing" INTEGER NOT NULL,
    "openingPrice" INTEGER NOT NULL,
    "bidIncrement" INTEGER NOT NULL,
    "salaryBaselineAtListing" INTEGER,
    "currentPrice" INTEGER NOT NULL,
    "leadingClubId" INTEGER,
    "relistStage" INTEGER NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "deadline" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "completedAt" BIGINT,
    "winningClubId" INTEGER,
    "finalPrice" INTEGER,
    "previousListingId" INTEGER,
    "blockedClubId" INTEGER,
    "unclaimedSince" BIGINT,
    "softClosed" BOOLEAN NOT NULL,

    CONSTRAINT "FreeAgentListing_pkey" PRIMARY KEY ("saveId","id")
);

-- CreateTable
CREATE TABLE "MarketReservation" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "listingId" INTEGER NOT NULL,
    "marketType" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "releasedAt" BIGINT,

    CONSTRAINT "MarketReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerMarketTransaction" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "listingId" INTEGER,
    "type" TEXT NOT NULL,
    "fromClubId" INTEGER,
    "toClubId" INTEGER,
    "price" INTEGER NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "seasonKey" TEXT NOT NULL,
    "seasonDayIndex" INTEGER,
    "matchday" INTEGER,
    "completedRounds" INTEGER,
    "contractSeasons" INTEGER,
    "contractSalary" INTEGER,
    "timestamp" BIGINT NOT NULL,

    CONSTRAINT "PlayerMarketTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpSeason" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "joinLockRound" INTEGER NOT NULL,
    "joinThresholdPercent" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "completedRounds" INTEGER NOT NULL DEFAULT 0,
    "joinState" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seasonNumber" INTEGER NOT NULL DEFAULT 0,
    "startAbsoluteGameDay" INTEGER NOT NULL DEFAULT 0,
    "endAbsoluteGameDay" INTEGER NOT NULL DEFAULT 0,
    "calendarVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "MpSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpMembership" (
    "id" SERIAL NOT NULL,
    "divisionId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "slotNumber" INTEGER NOT NULL,
    "isFillerAI" BOOLEAN NOT NULL DEFAULT false,
    "replacedClubId" INTEGER,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MpMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpClubSeason" (
    "id" SERIAL NOT NULL,
    "clubId" INTEGER NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "divisionId" INTEGER,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "goalsFor" INTEGER NOT NULL DEFAULT 0,
    "goalsAgainst" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "promotionStatus" TEXT NOT NULL DEFAULT 'NONE',
    "relegationStatus" TEXT NOT NULL DEFAULT 'NONE',

    CONSTRAINT "MpClubSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpQueue" (
    "id" SERIAL NOT NULL,
    "clubId" INTEGER NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "preferredSeasonId" INTEGER NOT NULL,

    CONSTRAINT "MpQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpAllocation" (
    "id" SERIAL NOT NULL,
    "clubId" INTEGER NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MpAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpActivity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "activityType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,

    CONSTRAINT "MpActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpAudit" (
    "id" SERIAL NOT NULL,
    "seasonId" INTEGER,
    "clubId" INTEGER,
    "userId" INTEGER,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,

    CONSTRAINT "MpAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "NamePoolEntry" (
    "id" SERIAL NOT NULL,
    "countryCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "NamePoolEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyExecution" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "executionType" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warning" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "issuedByAdminUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "Warning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotification" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "dedupeKey" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerSeasonHistory" (
    "id" SERIAL NOT NULL,
    "saveId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "seasonKey" TEXT NOT NULL,
    "clubId" INTEGER NOT NULL,
    "clubName" TEXT NOT NULL,
    "appearances" INTEGER NOT NULL,
    "goals" INTEGER NOT NULL,
    "assists" INTEGER NOT NULL,
    "yellows" INTEGER NOT NULL,
    "reds" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerSeasonHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Save_globalKey_key" ON "Save"("globalKey");

-- CreateIndex
CREATE INDEX "Friendship_userAId_idx" ON "Friendship"("userAId");

-- CreateIndex
CREATE INDEX "Friendship_userBId_idx" ON "Friendship"("userBId");

-- CreateIndex
CREATE UNIQUE INDEX "Friendship_userAId_userBId_key" ON "Friendship"("userAId", "userBId");

-- CreateIndex
CREATE INDEX "Invitation_inviterUserId_idx" ON "Invitation"("inviterUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GameClock_saveId_key" ON "GameClock"("saveId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledEvent_idempotencyKey_key" ON "ScheduledEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ScheduledEvent_saveId_status_timeBasis_dueAbsoluteGameDay_idx" ON "ScheduledEvent"("saveId", "status", "timeBasis", "dueAbsoluteGameDay");

-- CreateIndex
CREATE INDEX "ScheduledEvent_saveId_status_timeBasis_dueAt_idx" ON "ScheduledEvent"("saveId", "status", "timeBasis", "dueAt");

-- CreateIndex
CREATE INDEX "ScheduledEvent_entityType_entityId_idx" ON "ScheduledEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ScheduledEvent_type_status_idx" ON "ScheduledEvent"("type", "status");

-- CreateIndex
CREATE INDEX "AdminSchedulerAudit_saveId_createdAt_idx" ON "AdminSchedulerAudit"("saveId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminSchedulerAudit_adminUserId_createdAt_idx" ON "AdminSchedulerAudit"("adminUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Club_ownerUserId_key" ON "Club"("ownerUserId");

-- CreateIndex
CREATE INDEX "Club_saveId_idx" ON "Club"("saveId");

-- CreateIndex
CREATE INDEX "Club_saveId_ownerUserId_idx" ON "Club"("saveId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Club_saveId_ownerUserId_key" ON "Club"("saveId", "ownerUserId");

-- CreateIndex
CREATE INDEX "Player_saveId_clubId_idx" ON "Player"("saveId", "clubId");

-- CreateIndex
CREATE INDEX "Loan_saveId_playerId_idx" ON "Loan"("saveId", "playerId");

-- CreateIndex
CREATE INDEX "Competition_saveId_idx" ON "Competition"("saveId");

-- CreateIndex
CREATE INDEX "Competition_saveId_seasonId_tier_idx" ON "Competition"("saveId", "seasonId", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "Competition_saveId_seasonId_tier_groupIndex_key" ON "Competition"("saveId", "seasonId", "tier", "groupIndex");

-- CreateIndex
CREATE INDEX "StandingsRow_saveId_competitionId_idx" ON "StandingsRow"("saveId", "competitionId");

-- CreateIndex
CREATE INDEX "Fixture_saveId_competitionId_idx" ON "Fixture"("saveId", "competitionId");

-- CreateIndex
CREATE INDEX "Fixture_saveId_homeClubId_idx" ON "Fixture"("saveId", "homeClubId");

-- CreateIndex
CREATE INDEX "Fixture_saveId_awayClubId_idx" ON "Fixture"("saveId", "awayClubId");

-- CreateIndex
CREATE INDEX "Match_saveId_idx" ON "Match"("saveId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_saveId_fixtureId_key" ON "Match"("saveId", "fixtureId");

-- CreateIndex
CREATE INDEX "ClubEloEvent_saveId_clubId_createdAt_idx" ON "ClubEloEvent"("saveId", "clubId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClubEloEvent_saveId_matchId_clubId_key" ON "ClubEloEvent"("saveId", "matchId", "clubId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchStat_saveId_matchId_key" ON "MatchStat"("saveId", "matchId");

-- CreateIndex
CREATE INDEX "MatchEvent_saveId_matchId_idx" ON "MatchEvent"("saveId", "matchId");

-- CreateIndex
CREATE INDEX "MatchEvent_saveId_playerId_idx" ON "MatchEvent"("saveId", "playerId");

-- CreateIndex
CREATE INDEX "NewsItem_saveId_id_idx" ON "NewsItem"("saveId", "id");

-- CreateIndex
CREATE INDEX "LedgerEntry_saveId_clubId_idx" ON "LedgerEntry"("saveId", "clubId");

-- CreateIndex
CREATE INDEX "Trophy_saveId_clubId_idx" ON "Trophy"("saveId", "clubId");

-- CreateIndex
CREATE INDEX "SeasonAward_saveId_season_id_idx" ON "SeasonAward"("saveId", "season", "id");

-- CreateIndex
CREATE INDEX "CareerRecord_saveId_category_idx" ON "CareerRecord"("saveId", "category");

-- CreateIndex
CREATE INDEX "LiveMatch_saveId_homeClubId_idx" ON "LiveMatch"("saveId", "homeClubId");

-- CreateIndex
CREATE INDEX "LiveMatch_saveId_awayClubId_idx" ON "LiveMatch"("saveId", "awayClubId");

-- CreateIndex
CREATE INDEX "TransferAuction_saveId_status_idx" ON "TransferAuction"("saveId", "status");

-- CreateIndex
CREATE INDEX "TransferAuction_saveId_deadline_idx" ON "TransferAuction"("saveId", "deadline");

-- CreateIndex
CREATE INDEX "MarketBid_saveId_marketType_listingId_idx" ON "MarketBid"("saveId", "marketType", "listingId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketBid_saveId_marketType_listingId_clubId_key" ON "MarketBid"("saveId", "marketType", "listingId", "clubId");

-- CreateIndex
CREATE INDEX "FreeAgentListing_saveId_status_idx" ON "FreeAgentListing"("saveId", "status");

-- CreateIndex
CREATE INDEX "FreeAgentListing_saveId_deadline_idx" ON "FreeAgentListing"("saveId", "deadline");

-- CreateIndex
CREATE INDEX "MarketReservation_saveId_clubId_idx" ON "MarketReservation"("saveId", "clubId");

-- CreateIndex
CREATE INDEX "MarketReservation_saveId_marketType_listingId_idx" ON "MarketReservation"("saveId", "marketType", "listingId");

-- CreateIndex
CREATE INDEX "PlayerMarketTransaction_saveId_playerId_idx" ON "PlayerMarketTransaction"("saveId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "MpSeason_year_month_key" ON "MpSeason"("year", "month");

-- CreateIndex
CREATE INDEX "MpMembership_divisionId_idx" ON "MpMembership"("divisionId");

-- CreateIndex
CREATE UNIQUE INDEX "MpMembership_divisionId_clubId_key" ON "MpMembership"("divisionId", "clubId");

-- CreateIndex
CREATE UNIQUE INDEX "MpMembership_divisionId_slotNumber_key" ON "MpMembership"("divisionId", "slotNumber");

-- CreateIndex
CREATE INDEX "MpClubSeason_seasonId_idx" ON "MpClubSeason"("seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "MpClubSeason_clubId_seasonId_key" ON "MpClubSeason"("clubId", "seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "MpQueue_clubId_key" ON "MpQueue"("clubId");

-- CreateIndex
CREATE INDEX "MpAllocation_seasonId_idx" ON "MpAllocation"("seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "MpAllocation_clubId_seasonId_type_key" ON "MpAllocation"("clubId", "seasonId", "type");

-- CreateIndex
CREATE INDEX "MpActivity_clubId_occurredAt_idx" ON "MpActivity"("clubId", "occurredAt");

-- CreateIndex
CREATE INDEX "MpActivity_userId_occurredAt_idx" ON "MpActivity"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "MpAudit_seasonId_occurredAt_idx" ON "MpAudit"("seasonId", "occurredAt");

-- CreateIndex
CREATE INDEX "MpAudit_clubId_occurredAt_idx" ON "MpAudit"("clubId", "occurredAt");

-- CreateIndex
CREATE INDEX "NamePoolEntry_countryCode_kind_idx" ON "NamePoolEntry"("countryCode", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "NamePoolEntry_countryCode_kind_position_key" ON "NamePoolEntry"("countryCode", "kind", "position");

-- CreateIndex
CREATE INDEX "DailyExecution_saveId_date_idx" ON "DailyExecution"("saveId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyExecution_saveId_seasonId_date_executionType_key" ON "DailyExecution"("saveId", "seasonId", "date", "executionType");

-- CreateIndex
CREATE INDEX "Warning_userId_idx" ON "Warning"("userId");

-- CreateIndex
CREATE INDEX "Warning_userId_acknowledgedAt_idx" ON "Warning"("userId", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "UserNotification_userId_createdAt_idx" ON "UserNotification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserNotification_userId_occurredAt_idx" ON "UserNotification"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "UserNotification_userId_readAt_idx" ON "UserNotification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserNotification_userId_dedupeKey_key" ON "UserNotification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "PushSubscription_endpoint_idx" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_userId_endpoint_key" ON "PushSubscription"("userId", "endpoint");

-- CreateIndex
CREATE INDEX "PlayerSeasonHistory_saveId_playerId_idx" ON "PlayerSeasonHistory"("saveId", "playerId");

-- CreateIndex
CREATE INDEX "PlayerSeasonHistory_saveId_seasonId_idx" ON "PlayerSeasonHistory"("saveId", "seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerSeasonHistory_saveId_playerId_seasonId_key" ON "PlayerSeasonHistory"("saveId", "playerId", "seasonId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Save" ADD CONSTRAINT "Save_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_inviterUserId_fkey" FOREIGN KEY ("inviterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameClock" ADD CONSTRAINT "GameClock_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEvent" ADD CONSTRAINT "ScheduledEvent_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSchedulerAudit" ADD CONSTRAINT "AdminSchedulerAudit_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "MpSeason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandingsRow" ADD CONSTRAINT "StandingsRow_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fixture" ADD CONSTRAINT "Fixture_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEloEvent" ADD CONSTRAINT "ClubEloEvent_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchStat" ADD CONSTRAINT "MatchStat_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsItem" ADD CONSTRAINT "NewsItem_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trophy" ADD CONSTRAINT "Trophy_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonAward" ADD CONSTRAINT "SeasonAward_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerRecord" ADD CONSTRAINT "CareerRecord_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveMatch" ADD CONSTRAINT "LiveMatch_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferAuction" ADD CONSTRAINT "TransferAuction_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketBid" ADD CONSTRAINT "MarketBid_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeAgentListing" ADD CONSTRAINT "FreeAgentListing_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketReservation" ADD CONSTRAINT "MarketReservation_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerMarketTransaction" ADD CONSTRAINT "PlayerMarketTransaction_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MpClubSeason" ADD CONSTRAINT "MpClubSeason_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "MpSeason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MpAllocation" ADD CONSTRAINT "MpAllocation_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "MpSeason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyExecution" ADD CONSTRAINT "DailyExecution_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warning" ADD CONSTRAINT "Warning_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerSeasonHistory" ADD CONSTRAINT "PlayerSeasonHistory_saveId_fkey" FOREIGN KEY ("saveId") REFERENCES "Save"("id") ON DELETE CASCADE ON UPDATE CASCADE;

