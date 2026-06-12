-- CreateTable
CREATE TABLE "CostcoReceipt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "transactionBarcode" TEXT NOT NULL,
    "transactionDate" TEXT NOT NULL,
    "warehouseName" TEXT NOT NULL,
    "total" REAL NOT NULL,
    "receiptData" TEXT NOT NULL,
    "orderId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostcoReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CostcoReceipt_transactionBarcode_key" ON "CostcoReceipt"("transactionBarcode");
