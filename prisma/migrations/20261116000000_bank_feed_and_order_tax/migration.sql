-- Additive only: two nullable Order columns and three bank-feed tables.
ALTER TABLE "Order" ADD COLUMN "taxAmount" REAL;
ALTER TABLE "Order" ADD COLUMN "subtotalAmount" REAL;

CREATE TABLE "BankConnection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "accessUrlEnc" TEXT NOT NULL,
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "lastErrors" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BankConnection_userId_idx" ON "BankConnection"("userId");

CREATE TABLE "BankAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "connectionId" INTEGER,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orgName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "kind" TEXT NOT NULL DEFAULT 'other',
    "last4" TEXT,
    "creditCardId" INTEGER,
    "ledgerAccountId" INTEGER,
    "balanceCents" INTEGER,
    "balanceDate" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BankAccount_userId_provider_providerAccountId_key" ON "BankAccount"("userId", "provider", "providerAccountId");
CREATE INDEX "BankAccount_userId_idx" ON "BankAccount"("userId");

CREATE TABLE "BankTransaction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "bankAccountId" INTEGER NOT NULL,
    "providerTxnId" TEXT NOT NULL,
    "postedDate" TEXT NOT NULL,
    "transactedDate" TEXT,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "payee" TEXT,
    "memo" TEXT,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
    "matchedOrderId" INTEGER,
    "matchedTxnId" INTEGER,
    "suggestion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BankTransaction_bankAccountId_providerTxnId_key" ON "BankTransaction"("bankAccountId", "providerTxnId");
CREATE INDEX "BankTransaction_userId_postedDate_idx" ON "BankTransaction"("userId", "postedDate");
CREATE INDEX "BankTransaction_userId_matchStatus_idx" ON "BankTransaction"("userId", "matchStatus");
