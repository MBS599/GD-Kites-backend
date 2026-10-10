-- Amazon-style delivery address: structured parts, landmark, alternate mobile,
-- delivery instructions and a default address. Existing rows keep their "line".
ALTER TABLE "Address" ADD COLUMN "houseNumber" TEXT,
ADD COLUMN "buildingName" TEXT,
ADD COLUMN "street" TEXT,
ADD COLUMN "landmark" TEXT,
ADD COLUMN "state" TEXT,
ADD COLUMN "country" TEXT NOT NULL DEFAULT 'India',
ADD COLUMN "alternatePhone" TEXT,
ADD COLUMN "instructions" TEXT,
ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Each customer's oldest live address becomes their default.
UPDATE "Address" a SET "isDefault" = true
WHERE a."isDeleted" = false AND a."createdAt" = (
  SELECT min(b."createdAt") FROM "Address" b WHERE b."userId" = a."userId" AND b."isDeleted" = false
);

-- At most one default per customer.
CREATE UNIQUE INDEX "Address_one_default" ON "Address"("userId") WHERE "isDefault" AND NOT "isDeleted";

-- Order snapshot: what the driver needs at the door.
ALTER TABLE "Order" ADD COLUMN "addrLandmark" TEXT,
ADD COLUMN "addrInstructions" TEXT,
ADD COLUMN "altPhone" TEXT;
