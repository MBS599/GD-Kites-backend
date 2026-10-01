-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('SENT', 'LOGGED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "smsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "userId" TEXT,
    "orderId" TEXT,
    "body" TEXT NOT NULL,
    "status" "SmsStatus" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsMessage_createdAt_idx" ON "SmsMessage"("createdAt");

-- CreateIndex
CREATE INDEX "SmsMessage_event_to_orderId_idx" ON "SmsMessage"("event", "to", "orderId");
