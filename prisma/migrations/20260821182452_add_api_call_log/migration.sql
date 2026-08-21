-- CreateTable
CREATE TABLE "ApiCallLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "group" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" INTEGER,
    "requestBody" TEXT,
    "responseBody" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ApiCallLog_group_createdAt_idx" ON "ApiCallLog"("group", "createdAt");

-- CreateIndex
CREATE INDEX "ApiCallLog_createdAt_idx" ON "ApiCallLog"("createdAt");
