-- CreateTable
CREATE TABLE "Form1099K" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "payerName" TEXT NOT NULL,
    "payerKeys" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "transactions" INTEGER,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Form1099K_userId_year_payerName_key" ON "Form1099K"("userId", "year", "payerName");
