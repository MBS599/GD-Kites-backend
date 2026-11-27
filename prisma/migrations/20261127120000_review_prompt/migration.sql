-- In-app Google review prompt (every customer once, then after later deliveries until rated).
ALTER TABLE "User" ADD COLUMN "reviewPrompts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "reviewPromptedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "reviewedAt" TIMESTAMP(3);
