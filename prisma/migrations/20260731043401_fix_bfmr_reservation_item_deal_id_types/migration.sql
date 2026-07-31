-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BfmrReservation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "reserveId" TEXT,
    "internalKey" TEXT,
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
    "myTrackerId" INTEGER,
    "itemId" TEXT,
    "dealId" TEXT,
    CONSTRAINT "BfmrReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BfmrReservation" ("bfmrOrderId", "datePaid", "dealId", "dealTitle", "id", "internalKey", "itemId", "itemName", "lastSyncedAt", "myTrackerId", "purchaseId", "qty", "raw", "reserveId", "retailPrice", "shipmentId", "status", "totalPayout", "trackingNumber", "userId") SELECT "bfmrOrderId", "datePaid", "dealId", "dealTitle", "id", "internalKey", "itemId", "itemName", "lastSyncedAt", "myTrackerId", "purchaseId", "qty", "raw", "reserveId", "retailPrice", "shipmentId", "status", "totalPayout", "trackingNumber", "userId" FROM "BfmrReservation";
DROP TABLE "BfmrReservation";
ALTER TABLE "new_BfmrReservation" RENAME TO "BfmrReservation";
CREATE INDEX "BfmrReservation_userId_status_idx" ON "BfmrReservation"("userId", "status");
CREATE INDEX "BfmrReservation_bfmrOrderId_idx" ON "BfmrReservation"("bfmrOrderId");
CREATE INDEX "BfmrReservation_userId_internalKey_idx" ON "BfmrReservation"("userId", "internalKey");
CREATE UNIQUE INDEX "BfmrReservation_userId_reserveId_key" ON "BfmrReservation"("userId", "reserveId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
