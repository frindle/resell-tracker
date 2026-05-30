-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "platform" TEXT NOT NULL,
    "orderNumber" TEXT,
    "orderDate" DATETIME NOT NULL,
    "itemDescription" TEXT,
    "cost" REAL NOT NULL,
    "shippingCost" REAL NOT NULL DEFAULT 0,
    "salePrice" REAL,
    "buyerId" INTEGER,
    "cardId" INTEGER,
    "cashbackAmount" REAL NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "CreditCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("buyerId", "cardId", "cashbackAmount", "cost", "createdAt", "id", "itemDescription", "notes", "orderDate", "orderNumber", "platform", "salePrice", "shippingCost", "updatedAt") SELECT "buyerId", "cardId", "cashbackAmount", "cost", "createdAt", "id", "itemDescription", "notes", "orderDate", "orderNumber", "platform", "salePrice", "shippingCost", "updatedAt" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
