-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "deliveryGstPercent" DOUBLE PRECISION NOT NULL DEFAULT 18,
ADD COLUMN     "gatewayFeePercent" DOUBLE PRECISION NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryTax" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paymentFee" DECIMAL(10,2) NOT NULL DEFAULT 0;


-- Sane bounds (also validated by the API).
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_deliveryGstPercent_check" CHECK ("deliveryGstPercent" >= 0 AND "deliveryGstPercent" <= 28);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_gatewayFeePercent_check" CHECK ("gatewayFeePercent" >= 0 AND "gatewayFeePercent" <= 5);
