ALTER TABLE "Order" RENAME COLUMN "bfmrOrderId" TO "groupReferenceId";
ALTER TABLE "Order" ADD COLUMN "trackingValues" TEXT;
