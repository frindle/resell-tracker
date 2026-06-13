-- CreateTable
CREATE TABLE "BfmrWatcher" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "dealSlug" TEXT NOT NULL,
    "dealTitle" TEXT,
    "itemId" INTEGER NOT NULL,
    "itemName" TEXT,
    "qty" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastChecked" DATETIME,
    "lastResult" TEXT,
    "reservedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BfmrWatcher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
