-- App updates: minimum Android build (force update) and the message on the update screens.
ALTER TABLE "AppSettings" ADD COLUMN "androidMinBuild" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "updateMessage" TEXT;
