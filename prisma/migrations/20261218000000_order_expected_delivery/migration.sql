-- AlterTable
ALTER TABLE "Order" ADD COLUMN "expectedDeliveryEnd" DATETIME;
ALTER TABLE "Order" ADD COLUMN "expectedDeliverySeenAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "expectedDeliverySource" TEXT;
ALTER TABLE "Order" ADD COLUMN "expectedDeliveryStart" DATETIME;
