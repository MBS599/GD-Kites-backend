-- Who was adding the number and why it failed, for the "customers without a mobile" report.
ALTER TABLE "OtpChallenge" ADD COLUMN "userId" TEXT;
ALTER TABLE "OtpChallenge" ADD COLUMN "failure" TEXT;
CREATE INDEX "OtpChallenge_userId_idx" ON "OtpChallenge"("userId");
