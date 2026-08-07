-- AlterTable
ALTER TABLE "Order" ADD COLUMN "returnedCost" REAL NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrderReturn" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "bfmrLinkId" INTEGER,
    "commitmentLinkId" INTEGER,
    "itemName" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "refundAmount" REAL,
    "requestedAt" DATETIME,
    "receivedAt" DATETIME,
    "refundedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OrderReturn_orderId_idx" ON "OrderReturn"("orderId");

-- CreateIndex
CREATE INDEX "OrderReturn_bfmrLinkId_idx" ON "OrderReturn"("bfmrLinkId");

-- CreateIndex
CREATE INDEX "OrderReturn_commitmentLinkId_idx" ON "OrderReturn"("commitmentLinkId");
