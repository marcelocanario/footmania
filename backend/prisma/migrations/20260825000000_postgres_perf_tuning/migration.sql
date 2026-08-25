-- Performance tuning after the SQLite -> Postgres migration.
-- Additive indexes for hot query paths + drops of prefix-redundant indexes
-- that only add write amplification on the full-sync save path.

-- Hot lookups on ScheduledEvent by (saveId, type, entityType, entityId):
-- scheduler.ts AUCTION_END / contract-demand queries, admin.ts match/auction
-- event queries. Replaces the weak (type, status) index.
CREATE INDEX "ScheduledEvent_saveId_type_entityType_entityId_idx" ON "ScheduledEvent"("saveId", "type", "entityType", "entityId");
DROP INDEX "ScheduledEvent_type_status_idx";

-- Active listing per player (proFeatures player-profile checks).
CREATE INDEX "TransferAuction_saveId_playerId_status_idx" ON "TransferAuction"("saveId", "playerId", "status");
CREATE INDEX "FreeAgentListing_saveId_playerId_status_idx" ON "FreeAgentListing"("saveId", "playerId", "status");

-- Unread inbox query filters (userId, readAt IS NULL) and sorts by occurredAt.
CREATE INDEX "UserNotification_userId_readAt_occurredAt_idx" ON "UserNotification"("userId", "readAt", "occurredAt");

-- Player market history ordered by timestamp desc (take 20).
CREATE INDEX "PlayerMarketTransaction_saveId_playerId_timestamp_idx" ON "PlayerMarketTransaction"("saveId", "playerId", "timestamp");

-- Prefix-redundant indexes: covered by their composite siblings.
DROP INDEX "Club_saveId_idx";
DROP INDEX "Competition_saveId_idx";
