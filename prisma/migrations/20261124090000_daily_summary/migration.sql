-- Daily sales summary on WhatsApp (owner's number, every night at 10 PM IST).
ALTER TABLE "AppSettings" ADD COLUMN "dailySummaryTo" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "dailySummaryHour" INTEGER NOT NULL DEFAULT 22;
ALTER TABLE "AppSettings" ADD COLUMN "dailySummarySentOn" TEXT;

-- The owner asked for it on this number.
UPDATE "AppSettings" SET "dailySummaryTo" = '919860838860' WHERE id = 1;
