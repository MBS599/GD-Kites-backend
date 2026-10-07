-- Per-product minimum order quantity (e.g. charkhas are sold 6 at least).
ALTER TABLE "Product" ADD COLUMN "minQty" INTEGER;
ALTER TABLE "Product" ADD CONSTRAINT "Product_minQty_positive" CHECK ("minQty" IS NULL OR "minQty" >= 1);

-- Charkhas: at least 6.
UPDATE "Product" SET "minQty" = 6 WHERE "name" ILIKE '%charkha%' AND NOT "isCombo";
