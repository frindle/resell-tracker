-- AlterTable
ALTER TABLE "Order" ADD COLUMN "refundAmount" REAL;
ALTER TABLE "Order" ADD COLUMN "refundedAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "returnShippedAt" DATETIME;
