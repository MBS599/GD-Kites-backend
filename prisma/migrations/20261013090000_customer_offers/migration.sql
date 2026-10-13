-- CreateEnum
CREATE TYPE "OfferKind" AS ENUM ('PERCENT', 'FLAT');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "offerId" TEXT,
ADD COLUMN     "offerTitle" TEXT;

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" "OfferKind" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "maxDiscount" DECIMAL(10,2),
    "minOrder" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "usesPerCustomer" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferCustomer" (
    "offerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferCustomer_pkey" PRIMARY KEY ("offerId","userId")
);

-- CreateIndex
CREATE INDEX "OfferCustomer_userId_idx" ON "OfferCustomer"("userId");

-- CreateIndex
CREATE INDEX "Order_offerId_customerId_idx" ON "Order"("offerId", "customerId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferCustomer" ADD CONSTRAINT "OfferCustomer_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferCustomer" ADD CONSTRAINT "OfferCustomer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The total takes the offer discount off the goods; a discount never exceeds the goods.
ALTER TABLE "Order" DROP CONSTRAINT "Order_amounts_nonneg";
ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_nonneg" CHECK (
  "subtotal" >= 0 AND "deliveryCharge" >= 0 AND "deliveryTax" >= 0 AND "paymentFee" >= 0 AND "paidOnline" >= 0
  AND "packingCharge" >= 0 AND "discount" >= 0 AND "discount" <= "subtotal"
  AND "total" = "subtotal" - "discount" + "deliveryCharge" + "deliveryTax" + "paymentFee" + "packingCharge"
);
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_values_valid" CHECK (
  "value" > 0 AND ("kind" <> 'PERCENT' OR "value" <= 90) AND "minOrder" >= 0 AND "usesPerCustomer" >= 1
  AND ("maxDiscount" IS NULL OR "maxDiscount" > 0)
);
