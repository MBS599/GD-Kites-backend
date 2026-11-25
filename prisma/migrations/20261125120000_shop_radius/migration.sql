-- "Buy at the shop" in the customer app: allowed within this distance (metres) of the shop.
ALTER TABLE "AppSettings" ADD COLUMN "shopRadiusM" INTEGER NOT NULL DEFAULT 100;
