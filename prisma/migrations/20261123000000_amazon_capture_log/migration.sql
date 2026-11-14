CREATE TABLE "AmazonCaptureLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pageKind" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "changes" TEXT NOT NULL,
    "discrepancies" TEXT NOT NULL
);
CREATE INDEX "AmazonCaptureLog_userId_createdAt_idx" ON "AmazonCaptureLog"("userId", "createdAt");

CREATE TABLE "AmazonCaptureFailure" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pageKind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "html" TEXT NOT NULL
);
CREATE INDEX "AmazonCaptureFailure_userId_createdAt_idx" ON "AmazonCaptureFailure"("userId", "createdAt");
