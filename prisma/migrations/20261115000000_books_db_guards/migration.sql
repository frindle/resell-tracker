-- Additive guards (partial unique indexes; Prisma cannot express these in schema.prisma).
-- One live (not reversed, not a reversal row) journal entry per user + sourceKey, even across processes.
CREATE UNIQUE INDEX "JournalEntry_userId_sourceKey_live_key" ON "JournalEntry"("userId", "sourceKey") WHERE "reversedAt" IS NULL AND "source" <> 'reversal';

-- Bank / cash accounts (no systemKey) never share a code per user.
CREATE UNIQUE INDEX "LedgerAccount_userId_code_bank_key" ON "LedgerAccount"("userId", "code") WHERE "systemKey" IS NULL;
