-- Shop counter: bills made at the shop, and orders walk-in customers place from the shop QR.
ALTER TYPE "DeliveryMode" ADD VALUE 'COUNTER';

CREATE TYPE "ShopRequestStatus" AS ENUM ('WAITING', 'BILLED', 'REJECTED');

CREATE TABLE "ShopRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "status" "ShopRequestStatus" NOT NULL DEFAULT 'WAITING',
    "token" TEXT NOT NULL,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShopRequest_status_createdAt_idx" ON "ShopRequest"("status", "createdAt");
