-- Home tile picture and colour set per category (null = the app default).
ALTER TABLE "Category" ADD COLUMN "icon" TEXT,
ADD COLUMN "color" TEXT;
