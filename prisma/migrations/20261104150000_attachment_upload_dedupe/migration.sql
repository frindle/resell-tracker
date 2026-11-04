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
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "giftCardId" INTEGER,
    "contentSha256" TEXT,
    "sourceKey" TEXT,
    "uploadTokenId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderAttachment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OrderAttachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OrderAttachment_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OrderAttachment_uploadTokenId_fkey" FOREIGN KEY ("uploadTokenId") REFERENCES "UploadToken" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_OrderAttachment" ("createdAt", "filename", "giftCardId", "id", "mimeType", "orderId", "originalName", "rotation", "userId") SELECT "createdAt", "filename", "giftCardId", "id", "mimeType", "orderId", "originalName", "rotation", "userId" FROM "OrderAttachment";
DROP TABLE "OrderAttachment";
ALTER TABLE "new_OrderAttachment" RENAME TO "OrderAttachment";
CREATE INDEX "OrderAttachment_giftCardId_idx" ON "OrderAttachment"("giftCardId");
CREATE INDEX "OrderAttachment_userId_contentSha256_idx" ON "OrderAttachment"("userId", "contentSha256");
CREATE INDEX "OrderAttachment_userId_sourceKey_idx" ON "OrderAttachment"("userId", "sourceKey");
CREATE INDEX "OrderAttachment_uploadTokenId_idx" ON "OrderAttachment"("uploadTokenId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

