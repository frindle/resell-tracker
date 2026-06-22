-- CreateTable
CREATE TABLE "BuyingGroupCommitment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "commitmentId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "dealTitle" TEXT NOT NULL,
    "itemId" TEXT,
    "itemImage" TEXT,
    "count" INTEGER NOT NULL,
    "fulfilled" INTEGER NOT NULL,
    "expiryDay" DATETIME,
    "price" REAL NOT NULL,
    "commission" REAL NOT NULL DEFAULT 0,
    "total" REAL NOT NULL,
    "bgPointsReward" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "raw" TEXT,
    "createdDt" DATETIME,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuyingGroupCommitment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderCommitmentLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "commitmentId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderCommitmentLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderCommitmentLink_commitmentId_fkey" FOREIGN KEY ("commitmentId") REFERENCES "BuyingGroupCommitment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BuyingGroupCommitment_dealId_idx" ON "BuyingGroupCommitment"("dealId");

-- CreateIndex
CREATE INDEX "BuyingGroupCommitment_userId_status_idx" ON "BuyingGroupCommitment"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BuyingGroupCommitment_userId_commitmentId_key" ON "BuyingGroupCommitment"("userId", "commitmentId");

-- CreateIndex
CREATE INDEX "OrderCommitmentLink_commitmentId_idx" ON "OrderCommitmentLink"("commitmentId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCommitmentLink_orderId_commitmentId_key" ON "OrderCommitmentLink"("orderId", "commitmentId");
