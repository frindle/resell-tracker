-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "platform" TEXT NOT NULL,
    "orderNumber" TEXT,
    "orderDate" DATETIME NOT NULL,
    "itemDescription" TEXT,
    "cost" REAL NOT NULL,
    "shippingCost" REAL NOT NULL DEFAULT 0,
    "insuranceCost" REAL NOT NULL DEFAULT 0,
    "salePrice" REAL,
    "salePriceSynced" BOOLEAN NOT NULL DEFAULT false,
    "buyerId" INTEGER,
    "cardId" INTEGER,
    "cashbackAmount" REAL NOT NULL DEFAULT 0,
    "sourceUrl" TEXT,
    "shippingAddress" TEXT,
    "trackingNumbers" TEXT,
    "trackingSubmittedToBg" BOOLEAN NOT NULL DEFAULT false,
    "bgExpectedPayout" REAL,
    "bgPaidAmount" REAL,
    "notes" TEXT,
    "skipAddressBlock" BOOLEAN NOT NULL DEFAULT false,
    "ignoredByRule" BOOLEAN NOT NULL DEFAULT false,
    "bgCredited" BOOLEAN NOT NULL DEFAULT false,
    "bfmrOrderId" TEXT,
    "bfmrReceived" BOOLEAN NOT NULL DEFAULT false,
    "bfmrStatus" TEXT,
    "overdueAt" DATETIME,
    "lost" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "CreditCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("bfmrOrderId", "bfmrReceived", "bfmrStatus", "bgExpectedPayout", "bgPaidAmount", "buyerId", "cardId", "cashbackAmount", "cost", "createdAt", "id", "ignoredByRule", "insuranceCost", "itemDescription", "lost", "notes", "orderDate", "orderNumber", "overdueAt", "platform", "salePrice", "salePriceSynced", "shippingAddress", "shippingCost", "skipAddressBlock", "sourceUrl", "trackingNumbers", "trackingSubmittedToBg", "updatedAt", "userId") SELECT "bfmrOrderId", "bfmrReceived", "bfmrStatus", "bgExpectedPayout", "bgPaidAmount", "buyerId", "cardId", "cashbackAmount", "cost", "createdAt", "id", "ignoredByRule", "insuranceCost", "itemDescription", "lost", "notes", "orderDate", "orderNumber", "overdueAt", "platform", "salePrice", "salePriceSynced", "shippingAddress", "shippingCost", "skipAddressBlock", "sourceUrl", "trackingNumbers", "trackingSubmittedToBg", "updatedAt", "userId" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
