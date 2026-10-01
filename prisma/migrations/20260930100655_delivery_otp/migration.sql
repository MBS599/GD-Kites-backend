-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "otpAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otpCode" TEXT,
ADD COLUMN     "otpLastSentAt" TIMESTAMP(3),
ADD COLUMN     "otpSentCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otpVerifiedAt" TIMESTAMP(3);
