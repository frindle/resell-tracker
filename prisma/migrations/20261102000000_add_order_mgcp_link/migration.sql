-- CreateTable
CREATE TABLE "OrderMgcpLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "linkEnc" TEXT NOT NULL,
    "linkHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "giftCardId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderMgcpLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OrderMgcpLink_orderId_idx" ON "OrderMgcpLink"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderMgcpLink_orderId_linkHash_key" ON "OrderMgcpLink"("orderId", "linkHash");
