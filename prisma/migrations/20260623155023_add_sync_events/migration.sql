-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "platform" TEXT NOT NULL,
    "scraped" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncEventOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventId" INTEGER NOT NULL,
    "orderId" INTEGER,
    "orderNumber" TEXT,
    "action" TEXT NOT NULL,
    "changedFields" TEXT NOT NULL,
    CONSTRAINT "SyncEventOrder_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SyncEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SyncEvent_userId_createdAt_idx" ON "SyncEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncEventOrder_eventId_idx" ON "SyncEventOrder"("eventId");
