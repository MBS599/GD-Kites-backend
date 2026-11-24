-- Offers for every customer, and when customers were last notified about an offer.
ALTER TABLE "Offer" ADD COLUMN "forEveryone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Offer" ADD COLUMN "notifiedAt" TIMESTAMP(3);
