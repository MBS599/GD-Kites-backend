-- CreateTable
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "maxServiceRadiusKm" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_singleton" CHECK ("id" = 1);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_max_radius_range" CHECK ("maxServiceRadiusKm" >= 1 AND "maxServiceRadiusKm" <= 1000);
INSERT INTO "AppSettings" ("id", "maxServiceRadiusKm", "updatedAt") VALUES (1, 100, now()) ON CONFLICT DO NOTHING;

-- Radius limit is now admin-controlled (AppSettings); keep only a hard ceiling here.
ALTER TABLE "ServiceArea" DROP CONSTRAINT "ServiceArea_radius_range";
ALTER TABLE "ServiceArea" ADD CONSTRAINT "ServiceArea_radius_range" CHECK ("radiusKm" > 0 AND "radiusKm" <= 1000);
