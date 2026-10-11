-- Optional cap on a driver's open (assigned / in transit) deliveries; NULL = no limit.
ALTER TABLE "DriverProfile" ADD COLUMN "maxActiveDeliveries" INTEGER;
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_max_active_positive" CHECK ("maxActiveDeliveries" IS NULL OR "maxActiveDeliveries" > 0);
