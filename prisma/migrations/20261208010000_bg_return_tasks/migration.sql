-- AlterTable
ALTER TABLE "OrderReturn" ADD COLUMN "source" TEXT;
ALTER TABLE "OrderReturn" ADD COLUMN "externalKey" TEXT;
ALTER TABLE "OrderReturn" ADD COLUMN "groupStatus" TEXT;
ALTER TABLE "OrderReturn" ADD COLUMN "supportId" TEXT;
ALTER TABLE "OrderReturn" ADD COLUMN "returnTracking" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OrderReturn_externalKey_key" ON "OrderReturn"("externalKey");

-- CreateTable
CREATE TABLE "BgReturnTask" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "taskKey" TEXT NOT NULL,
    "receiptId" TEXT,
    "sku" TEXT,
    "serial" TEXT,
    "status" TEXT NOT NULL,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "supportId" TEXT,
    "tracking" TEXT,
    "note" TEXT,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "createdDt" TEXT,
    "updatedDt" TEXT,
    "orderId" INTEGER,
    "matchedBy" TEXT,
    "effect" TEXT,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BgReturnTask_orderId_idx" ON "BgReturnTask"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "BgReturnTask_userId_taskKey_key" ON "BgReturnTask"("userId", "taskKey");
