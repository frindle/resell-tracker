-- CreateTable
CREATE TABLE "GroupPayment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "buyerId" INTEGER,
    "group" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidDate" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GroupPaymentOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "paymentId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    CONSTRAINT "GroupPaymentOrder_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "GroupPayment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GroupPayment_userId_amountCents_idx" ON "GroupPayment"("userId", "amountCents");

-- CreateIndex
CREATE UNIQUE INDEX "GroupPayment_userId_group_externalRef_key" ON "GroupPayment"("userId", "group", "externalRef");

-- CreateIndex
CREATE INDEX "GroupPaymentOrder_orderId_idx" ON "GroupPaymentOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupPaymentOrder_paymentId_orderId_key" ON "GroupPaymentOrder"("paymentId", "orderId");
