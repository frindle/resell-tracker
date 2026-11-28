-- AlterTable
ALTER TABLE "Order" ADD COLUMN "darkbloomCategory" TEXT;
ALTER TABLE "Order" ADD COLUMN "darkbloomMachineId" TEXT;
ALTER TABLE "Order" ADD COLUMN "bloomEntryId" INTEGER;
ALTER TABLE "Order" ADD COLUMN "bloomSyncedAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "bloomPushedSig" TEXT;
ALTER TABLE "Order" ADD COLUMN "bloomRev" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "bloomPushNote" TEXT;
