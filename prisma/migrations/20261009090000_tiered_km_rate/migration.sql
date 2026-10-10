-- Two-step per-km rate: perKm for the first tierKm km, then perKmAfter beyond.
ALTER TABLE "VehicleType" ADD COLUMN "tierKm" DOUBLE PRECISION,
ADD COLUMN "perKmAfter" DECIMAL(10,2);
ALTER TABLE "VehicleType" ADD CONSTRAINT "VehicleType_tier_pair"
  CHECK (("tierKm" IS NULL) = ("perKmAfter" IS NULL) AND ("tierKm" IS NULL OR ("tierKm" > 0 AND "perKmAfter" >= 0)));

-- The Tempo (customer delivery charge): Rs 50 + Rs 10/km for the first 5 km, Rs 8/km after.
UPDATE "VehicleType" SET "baseFare" = 50, "perKm" = 10, "tierKm" = 5, "perKmAfter" = 8 WHERE lower("name") = 'tempo';
