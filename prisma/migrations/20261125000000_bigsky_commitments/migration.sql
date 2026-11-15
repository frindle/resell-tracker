-- CreateTable
CREATE TABLE "BigSkyCommitment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "commitmentId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "itemUpc" TEXT NOT NULL,
    "dealPrice" REAL NOT NULL,
    "commitmentAmount" INTEGER NOT NULL,
    "fulfilled" INTEGER NOT NULL,
    "commitmentsRemaining" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "dealCreated" DATETIME,
    "dealExpiration" DATETIME,
    "creationDate" DATETIME,
    "fulfillmentDate" DATETIME,
    "fulfillments" TEXT NOT NULL DEFAULT '[]',
    "raw" TEXT,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BigSkyCommitment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BigSkyCommitment_userId_status_idx" ON "BigSkyCommitment"("userId", "status");

-- CreateIndex
CREATE INDEX "BigSkyCommitment_itemUpc_idx" ON "BigSkyCommitment"("itemUpc");

-- CreateIndex
CREATE UNIQUE INDEX "BigSkyCommitment_userId_commitmentId_key" ON "BigSkyCommitment"("userId", "commitmentId");
