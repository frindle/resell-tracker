-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OrderAttachment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER,
    "userId" INTEGER,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderAttachment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OrderAttachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_OrderAttachment" ("id", "orderId", "filename", "originalName", "mimeType", "createdAt") SELECT "id", "orderId", "filename", "originalName", "mimeType", "createdAt" FROM "OrderAttachment";
DROP TABLE "OrderAttachment";
ALTER TABLE "new_OrderAttachment" RENAME TO "OrderAttachment";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
