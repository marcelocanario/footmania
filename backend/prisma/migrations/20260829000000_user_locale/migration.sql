-- Add nullable player-facing language preference. Cross-device sync only:
-- the server never renders localized text, so nothing reads it for output.
ALTER TABLE "User" ADD COLUMN "locale" TEXT;