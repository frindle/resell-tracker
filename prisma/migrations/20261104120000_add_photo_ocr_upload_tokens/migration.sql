-- CreateTable
CREATE TABLE "PhotoOcr" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "attachmentId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "kind" TEXT,
    "texts" TEXT,
    "candidates" TEXT,
    "receipt" TEXT,
    "strength" TEXT,
    "suggestedOrderId" INTEGER,
    "giftCardId" INTEGER,
    "alternatives" TEXT,
    "reason" TEXT,
    "autoAssigned" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "capturedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PhotoOcr_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "OrderAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UploadToken" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "UploadToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PhotoOcr_attachmentId_key" ON "PhotoOcr"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadToken_tokenHash_key" ON "UploadToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UploadToken_userId_idx" ON "UploadToken"("userId");

