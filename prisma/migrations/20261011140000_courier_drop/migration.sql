-- "Send by courier": GD drops the parcel at a courier office the customer chooses.
-- Only a packing charge (from the settings master) applies; no delivery charge.
CREATE TYPE "AddressKind" AS ENUM ('SHOP', 'COURIER');
CREATE TYPE "DeliveryMode" AS ENUM ('LOCAL', 'COURIER');

ALTER TABLE "AppSettings" ADD COLUMN "courierEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "courierPackingCharge" DECIMAL(10,2) NOT NULL DEFAULT 200;

ALTER TABLE "Address" ADD COLUMN "kind" "AddressKind" NOT NULL DEFAULT 'SHOP',
ADD COLUMN "courierName" TEXT;

ALTER TABLE "Order" ADD COLUMN "deliveryMode" "DeliveryMode" NOT NULL DEFAULT 'LOCAL',
ADD COLUMN "packingCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN "courierName" TEXT,
ADD COLUMN "courierDocket" TEXT;

-- The order total now includes the packing charge.
ALTER TABLE "Order" DROP CONSTRAINT "Order_amounts_nonneg";
ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_nonneg" CHECK (
  "subtotal" >= 0 AND "deliveryCharge" >= 0 AND "deliveryTax" >= 0 AND "paymentFee" >= 0 AND "paidOnline" >= 0
  AND "packingCharge" >= 0
  AND "total" = "subtotal" + "deliveryCharge" + "deliveryTax" + "paymentFee" + "packingCharge"
);
