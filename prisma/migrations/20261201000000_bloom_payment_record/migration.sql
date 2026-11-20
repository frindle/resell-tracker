-- CreateTable
CREATE TABLE "BloomPayoutRequest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "ledgerKey" TEXT,
    "requestedAt" TEXT NOT NULL,
    "requestedCents" INTEGER NOT NULL,
    "refundedAt" TEXT,
    "sentDate" TEXT,
    "sentCents" INTEGER,
    "sentTxnId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BloomInvoiceCopy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "copy" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "dueCents" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "BloomPayoutRequest_userId_ledgerKey_key" ON "BloomPayoutRequest"("userId", "ledgerKey");

-- CreateIndex
CREATE UNIQUE INDEX "BloomInvoiceCopy_userId_month_copy_key" ON "BloomInvoiceCopy"("userId", "month", "copy");
