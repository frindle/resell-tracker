-- CreateTable
CREATE TABLE "BfmrReservation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "reserveId" TEXT,
    "purchaseId" TEXT,
    "shipmentId" TEXT,
    "bfmrOrderId" TEXT,
    "trackingNumber" TEXT,
    "dealTitle" TEXT,
    "itemName" TEXT,
    "status" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "retailPrice" REAL,
    "totalPayout" REAL,
    "datePaid" DATETIME,
    "raw" TEXT,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BfmrReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderBfmrLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "trackingNumber" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "value" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderBfmrLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderBfmrLink_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "BfmrReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BfmrReservation_userId_status_idx" ON "BfmrReservation"("userId", "status");

-- CreateIndex
CREATE INDEX "BfmrReservation_bfmrOrderId_idx" ON "BfmrReservation"("bfmrOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "BfmrReservation_userId_reserveId_key" ON "BfmrReservation"("userId", "reserveId");

-- CreateIndex
CREATE INDEX "OrderBfmrLink_reservationId_idx" ON "OrderBfmrLink"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderBfmrLink_orderId_reservationId_trackingNumber_key" ON "OrderBfmrLink"("orderId", "reservationId", "trackingNumber");
