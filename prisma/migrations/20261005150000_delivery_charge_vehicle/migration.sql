-- One delivery rate: the customer delivery charge uses a vehicle type's rate (the Tempo),
-- set in admin settings. Driver pay stays per driver (vehicle type or custom rate).
ALTER TABLE "AppSettings" ADD COLUMN "deliveryVehicleTypeId" TEXT;
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_deliveryVehicleTypeId_fkey" FOREIGN KEY ("deliveryVehicleTypeId") REFERENCES "VehicleType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "AppSettings" ("id", "updatedAt") VALUES (1, now()) ON CONFLICT ("id") DO NOTHING;
UPDATE "AppSettings"
SET "deliveryVehicleTypeId" = (
  SELECT "id" FROM "VehicleType" WHERE lower("name") = 'tempo' ORDER BY "isActive" DESC LIMIT 1
)
WHERE "id" = 1;

-- Per-area delivery rates are gone.
ALTER TABLE "ServiceArea" DROP CONSTRAINT IF EXISTS "ServiceArea_rates_nonneg";
ALTER TABLE "ServiceArea" DROP COLUMN "deliveryBaseCharge",
DROP COLUMN "deliveryPerKm";
