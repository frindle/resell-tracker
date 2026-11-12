-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "business" TEXT NOT NULL DEFAULT 'resell',
    "scheduleCLine" TEXT,
    "systemKey" TEXT,
    "creditCardId" INTEGER,
    "buyerId" INTEGER,
    "loanId" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "reversesId" INTEGER,
    "reversedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "entryId" INTEGER NOT NULL,
    "accountId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "orderId" INTEGER,
    "machineId" TEXT,
    "memo" TEXT,
    "business" TEXT,
    CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PeriodLock" (
    "userId" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "month")
);

-- CreateTable
CREATE TABLE "OrderEventDate" (
    "orderId" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "date" TEXT NOT NULL,

    PRIMARY KEY ("orderId", "event")
);

-- CreateTable
CREATE TABLE "CostEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "business" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "vendor" TEXT,
    "purpose" TEXT,
    "businessPct" INTEGER NOT NULL DEFAULT 100,
    "paidFromAccountId" INTEGER NOT NULL,
    "attachmentFile" TEXT,
    "attachmentName" TEXT,
    "attachmentMime" TEXT,
    "note" TEXT,
    "voidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostEntry_paidFromAccountId_fkey" FOREIGN KEY ("paidFromAccountId") REFERENCES "LedgerAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DarkbloomTally" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedEntryId" INTEGER
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT
);

-- CreateIndex
CREATE INDEX "LedgerAccount_userId_code_idx" ON "LedgerAccount"("userId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_userId_systemKey_key" ON "LedgerAccount"("userId", "systemKey");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_sourceKey_idx" ON "JournalEntry"("userId", "sourceKey");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_date_idx" ON "JournalEntry"("userId", "date");

-- CreateIndex
CREATE INDEX "JournalLine_orderId_idx" ON "JournalLine"("orderId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "CostEntry_userId_date_idx" ON "CostEntry"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DarkbloomTally_userId_month_key" ON "DarkbloomTally"("userId", "month");

-- CreateIndex
CREATE INDEX "AuditLog_userId_at_idx" ON "AuditLog"("userId", "at");

