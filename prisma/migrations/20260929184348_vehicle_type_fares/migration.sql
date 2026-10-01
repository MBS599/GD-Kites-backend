-- AlterTable
ALTER TABLE "DriverProfile" ADD COLUMN     "customBaseFare" DECIMAL(10,2),
ADD COLUMN     "customPerKm" DECIMAL(10,2),
ADD COLUMN     "vehicleTypeId" TEXT;

-- AlterTable
ALTER TABLE "ServiceArea" DROP COLUMN "driverBaseFare",
DROP COLUMN "driverPerKm";

-- CreateTable
CREATE TABLE "VehicleType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseFare" DECIMAL(10,2) NOT NULL,
    "perKm" DECIMAL(10,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleType_name_key" ON "VehicleType"("name");

-- AddForeignKey
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_vehicleTypeId_fkey" FOREIGN KEY ("vehicleTypeId") REFERENCES "VehicleType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Fares must be non-negative; a custom fare needs both parts.
ALTER TABLE "VehicleType" ADD CONSTRAINT "VehicleType_fares_nonneg" CHECK ("baseFare" >= 0 AND "perKm" >= 0);
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_custom_fare_pair" CHECK (("customBaseFare" IS NULL) = ("customPerKm" IS NULL));
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_custom_fare_nonneg" CHECK ("customBaseFare" IS NULL OR ("customBaseFare" >= 0 AND "customPerKm" >= 0));

-- Default vehicle categories; existing drivers start on Bike (the previous flat driver rate).
INSERT INTO "VehicleType" ("id", "name", "baseFare", "perKm", "sortOrder", "updatedAt") VALUES
  (gen_random_uuid()::text, 'Bike', 40, 13, 0, now()),
  (gen_random_uuid()::text, 'Auto rickshaw', 70, 18, 1, now()),
  (gen_random_uuid()::text, 'Tempo', 150, 25, 2, now())
ON CONFLICT ("name") DO NOTHING;
UPDATE "DriverProfile" SET "vehicleTypeId" = (SELECT "id" FROM "VehicleType" WHERE "name" = 'Bike') WHERE "vehicleTypeId" IS NULL;