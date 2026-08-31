-- Serialized locale-independent news body (frame key or direct message ref).
-- NULL = legacy row: the client renders the persisted English `text`.
ALTER TABLE "NewsItem" ADD COLUMN "bodyJson" TEXT;