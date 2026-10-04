-- DropForeignKey
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_productId_fkey";

-- DropIndex
DROP INDEX "Product_isActive_stock_idx";

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "lowStockThreshold",
DROP COLUMN "minOrderQty",
DROP COLUMN "size",
DROP COLUMN "stock",
ADD COLUMN     "damageNote" TEXT,
ADD COLUMN     "inStock" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isDamaged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sizeId" TEXT;

-- DropTable
DROP TABLE "InventoryMovement";

-- DropEnum
DROP TYPE "InventoryReason";

-- CreateTable
CREATE TABLE "Size" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Size_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Size_name_key" ON "Size"("name");

-- CreateIndex
CREATE INDEX "Product_isActive_inStock_idx" ON "Product"("isActive", "inStock");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Starting size master (admins can rename, reorder, hide or add more).
INSERT INTO "Size" ("id", "name", "sortOrder") VALUES
  (gen_random_uuid()::text, 'Small', 0),
  (gen_random_uuid()::text, 'Medium', 1),
  (gen_random_uuid()::text, 'Big', 2)
ON CONFLICT ("name") DO NOTHING;
