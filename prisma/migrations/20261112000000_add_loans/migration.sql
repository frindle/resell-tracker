-- CreateTable
CREATE TABLE "Loan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cardId" INTEGER,
    "principalCents" INTEGER NOT NULL DEFAULT 0,
    "aprPercent" REAL,
    "termMonths" INTEGER,
    "startDate" DATETIME,
    "firstPaymentDate" DATETIME,
    "originationFeeCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Loan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Loan_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "CreditCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoanEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "loanId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "postedAt" DATETIME NOT NULL,
    "interestCents" INTEGER NOT NULL DEFAULT 0,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "principalCents" INTEGER NOT NULL DEFAULT 0,
    "balanceCents" INTEGER,
    "periodIndex" INTEGER,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoanEntry_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LoanEntry_loanId_postedAt_idx" ON "LoanEntry"("loanId", "postedAt");
