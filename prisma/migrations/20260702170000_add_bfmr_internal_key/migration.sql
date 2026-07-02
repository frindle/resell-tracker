-- AlterTable
ALTER TABLE "BfmrReservation" ADD COLUMN "internalKey" TEXT;

-- CreateIndex
CREATE INDEX "BfmrReservation_userId_internalKey_idx" ON "BfmrReservation"("userId", "internalKey");
