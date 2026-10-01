-- AlterTable
ALTER TABLE "ServiceArea" ADD COLUMN     "deliveryBaseCharge" DECIMAL(10,2) NOT NULL DEFAULT 60,
ADD COLUMN     "deliveryPerKm" DECIMAL(10,2) NOT NULL DEFAULT 30,
ADD COLUMN     "driverBaseFare" DECIMAL(10,2) NOT NULL DEFAULT 40,
ADD COLUMN     "driverPerKm" DECIMAL(10,2) NOT NULL DEFAULT 13;

ALTER TABLE "ServiceArea" ADD CONSTRAINT "ServiceArea_rates_nonneg" CHECK ("deliveryBaseCharge" >= 0 AND "deliveryPerKm" >= 0 AND "driverBaseFare" >= 0 AND "driverPerKm" >= 0);
