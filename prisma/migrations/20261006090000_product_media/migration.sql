-- Product page like an online shop: photo/video gallery, highlights and a specifications table.
ALTER TABLE "Product" ADD COLUMN "highlights" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "media" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "specs" JSONB NOT NULL DEFAULT '[]';

-- The existing photo becomes the first item of the gallery.
UPDATE "Product"
SET "media" = jsonb_build_array(jsonb_build_object('type', 'image', 'url', "imageUrl"))
WHERE "imageUrl" IS NOT NULL AND "imageUrl" <> '';
