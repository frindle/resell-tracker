-- AlterTable
ALTER TABLE "GiftCard" ADD COLUMN "ccPaymentStatus" TEXT;
ALTER TABLE "GiftCard" ADD COLUMN "ccPaymentName" TEXT;

-- CreateIndex
CREATE INDEX "GiftCard_orderId_ccPaymentStatus_idx" ON "GiftCard"("orderId", "ccPaymentStatus");
