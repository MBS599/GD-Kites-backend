-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "dispatchMaxOrders" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "dispatchRadiusKm" DOUBLE PRECISION NOT NULL DEFAULT 4;


-- Sane bounds (also validated by the API).
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_dispatchRadiusKm_check" CHECK ("dispatchRadiusKm" >= 0.5 AND "dispatchRadiusKm" <= 1000);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_dispatchMaxOrders_check" CHECK ("dispatchMaxOrders" >= 1 AND "dispatchMaxOrders" <= 100);
