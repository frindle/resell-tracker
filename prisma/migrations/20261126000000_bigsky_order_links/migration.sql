-- CreateTable
CREATE TABLE "OrderBigSkyLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "commitmentId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderBigSkyLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderBigSkyLink_commitmentId_fkey" FOREIGN KEY ("commitmentId") REFERENCES "BigSkyCommitment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OrderBigSkyLink_commitmentId_idx" ON "OrderBigSkyLink"("commitmentId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderBigSkyLink_orderId_commitmentId_key" ON "OrderBigSkyLink"("orderId", "commitmentId");
