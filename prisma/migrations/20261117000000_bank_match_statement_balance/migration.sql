-- Additive only: link table for bank rows and statement balances. The old BankTransaction columns stay (read-only).
CREATE TABLE "BankMatch" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "txnId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" INTEGER NOT NULL DEFAULT 0,
    "amountCents" INTEGER NOT NULL,
    "note" TEXT,
    "matchedBy" TEXT NOT NULL DEFAULT 'user',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankMatch_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "BankTransaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BankMatch_txnId_kind_refId_key" ON "BankMatch"("txnId", "kind", "refId");
CREATE INDEX "BankMatch_userId_kind_refId_idx" ON "BankMatch"("userId", "kind", "refId");

CREATE TABLE "StatementBalance" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bankAccountId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatementBalance_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StatementBalance_bankAccountId_date_source_key" ON "StatementBalance"("bankAccountId", "date", "source");

-- Copy today's single refs into links (order charge, and transfer to the other row). Matched rows only.
INSERT INTO "BankMatch" ("userId", "txnId", "kind", "refId", "amountCents", "matchedBy")
SELECT "userId", "id", 'order_charge', "matchedOrderId", ABS("amountCents"), 'user'
FROM "BankTransaction" WHERE "matchStatus" = 'matched' AND "matchedOrderId" IS NOT NULL;

INSERT INTO "BankMatch" ("userId", "txnId", "kind", "refId", "amountCents", "matchedBy")
SELECT "userId", "id", 'transfer', "matchedTxnId", ABS("amountCents"), 'user'
FROM "BankTransaction" WHERE "matchStatus" = 'matched' AND "matchedTxnId" IS NOT NULL AND "matchedOrderId" IS NULL;

INSERT INTO "BankMatch" ("userId", "txnId", "kind", "refId", "amountCents", "matchedBy")
SELECT "userId", "id", 'ignore', 0, ABS("amountCents"), 'user'
FROM "BankTransaction" WHERE "matchStatus" = 'ignored';
