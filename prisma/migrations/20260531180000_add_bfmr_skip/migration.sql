-- CreateTable
CREATE TABLE "BfmrSkip" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderNumber" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "BfmrSkip_orderNumber_key" ON "BfmrSkip"("orderNumber");
