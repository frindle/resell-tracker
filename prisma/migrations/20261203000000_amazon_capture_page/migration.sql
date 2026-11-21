-- CreateTable
CREATE TABLE "AmazonCapturePage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pageKind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "rawBytes" INTEGER NOT NULL,
    "htmlGz" BLOB,
    "summary" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "AmazonCapturePage_userId_createdAt_idx" ON "AmazonCapturePage"("userId", "createdAt");
