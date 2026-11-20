-- CreateTable
CREATE TABLE "OrderPackage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "carrier" TEXT,
    "itemsKnown" BOOLEAN NOT NULL DEFAULT false,
    "itemsJson" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderPackage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BfmrDryRunLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" INTEGER NOT NULL,
    "orderNumber" TEXT,
    "trackingNumber" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "message" TEXT NOT NULL,
    "wouldSubmit" TEXT NOT NULL DEFAULT '[]',
    "caveats" TEXT NOT NULL DEFAULT '[]',
    "signature" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "OrderPackage_userId_trackingNumber_idx" ON "OrderPackage"("userId", "trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPackage_orderId_trackingNumber_key" ON "OrderPackage"("orderId", "trackingNumber");

-- CreateIndex
CREATE INDEX "BfmrDryRunLog_userId_createdAt_idx" ON "BfmrDryRunLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BfmrDryRunLog_userId_orderId_trackingNumber_idx" ON "BfmrDryRunLog"("userId", "orderId", "trackingNumber");
