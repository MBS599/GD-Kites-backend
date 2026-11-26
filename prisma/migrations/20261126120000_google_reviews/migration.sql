-- Google reviews: the review link (admin setting) and when each customer was asked.
ALTER TABLE "AppSettings" ADD COLUMN "googleReviewUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "reviewAskedAt" TIMESTAMP(3);
UPDATE "AppSettings" SET "googleReviewUrl" = 'https://share.google/3B2SduHzPbttRgvyn' WHERE id = 1;
-- Customers who already have a delivered order are not asked (only new first deliveries).
UPDATE "User" u SET "reviewAskedAt" = now()
WHERE u.role = 'CUSTOMER' AND EXISTS (SELECT 1 FROM "Order" o WHERE o."customerId" = u.id AND o.status = 'DELIVERED');
