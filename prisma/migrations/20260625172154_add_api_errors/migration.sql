-- Centralized API error log
CREATE TABLE "ApiError" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "group" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT,
    "status" INTEGER,
    "body" TEXT,
    "orderId" INTEGER,
    "context" TEXT,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiError_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ApiError_userId_seen_createdAt_idx" ON "ApiError"("userId", "seen", "createdAt");
CREATE INDEX "ApiError_group_createdAt_idx" ON "ApiError"("group", "createdAt");
