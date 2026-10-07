-- Unread notification count: when the user last opened their notifications.
ALTER TABLE "User" ADD COLUMN "notificationsSeenAt" TIMESTAMP(3);
-- Existing users start with everything read (no badge for old updates).
UPDATE "User" SET "notificationsSeenAt" = now();
