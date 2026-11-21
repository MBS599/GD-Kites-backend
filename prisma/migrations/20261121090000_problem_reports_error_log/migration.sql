-- "Report a problem" (app, web app, website, shop QR page) and the error log (client errors and server 500s).
CREATE TYPE "ProblemReportStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "ProblemReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT,
    "phone" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "screen" TEXT,
    "source" TEXT NOT NULL,
    "platform" TEXT,
    "appVersion" TEXT,
    "device" TEXT,
    "imageUrl" TEXT,
    "status" "ProblemReportStatus" NOT NULL DEFAULT 'OPEN',
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "ProblemReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProblemReport_status_createdAt_idx" ON "ProblemReport"("status", "createdAt");
CREATE INDEX "ProblemReport_userId_idx" ON "ProblemReport"("userId");

CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "screen" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "device" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ErrorLog_createdAt_idx" ON "ErrorLog"("createdAt");
CREATE INDEX "ErrorLog_userId_createdAt_idx" ON "ErrorLog"("userId", "createdAt");
