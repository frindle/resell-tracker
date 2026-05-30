-- CreateTable
CREATE TABLE "BgDealSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dealId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "retailPrice" REAL NOT NULL,
    "payoutPrice" REAL NOT NULL,
    "snapshotAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BgDealSnapshot_dealId_idx" ON "BgDealSnapshot"("dealId");
