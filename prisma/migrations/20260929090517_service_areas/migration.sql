-- AlterTable
ALTER TABLE "Address" ADD COLUMN     "serviceAreaId" TEXT;

-- AlterTable
ALTER TABLE "DriverProfile" ADD COLUMN     "serviceAreaId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "serviceAreaId" TEXT;

-- CreateTable
CREATE TABLE "ServiceArea" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "centerLat" DOUBLE PRECISION NOT NULL,
    "centerLng" DOUBLE PRECISION NOT NULL,
    "radiusKm" DOUBLE PRECISION NOT NULL,
    "hubName" TEXT NOT NULL,
    "hubLat" DOUBLE PRECISION NOT NULL,
    "hubLng" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceArea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceArea_name_key" ON "ServiceArea"("name");

-- CreateIndex
CREATE INDEX "ServiceArea_isActive_idx" ON "ServiceArea"("isActive");

-- CreateIndex
CREATE INDEX "Order_serviceAreaId_status_idx" ON "Order"("serviceAreaId", "status");

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_serviceAreaId_fkey" FOREIGN KEY ("serviceAreaId") REFERENCES "ServiceArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_serviceAreaId_fkey" FOREIGN KEY ("serviceAreaId") REFERENCES "ServiceArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_serviceAreaId_fkey" FOREIGN KEY ("serviceAreaId") REFERENCES "ServiceArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Geofence sanity
ALTER TABLE "ServiceArea" ADD CONSTRAINT "ServiceArea_radius_range" CHECK ("radiusKm" > 0 AND "radiusKm" <= 200);
ALTER TABLE "ServiceArea" ADD CONSTRAINT "ServiceArea_coords" CHECK (abs("centerLat") <= 90 AND abs("centerLng") <= 180 AND abs("hubLat") <= 90 AND abs("hubLng") <= 180);
