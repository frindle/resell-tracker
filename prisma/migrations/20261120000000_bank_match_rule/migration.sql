-- Additive only: user-made rules for bank rows (Books P3 step 3d).
CREATE TABLE "MatchRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "bankAccountId" INTEGER,
    "pattern" TEXT NOT NULL,
    "isRegex" BOOLEAN NOT NULL DEFAULT false,
    "sign" TEXT NOT NULL DEFAULT 'any',
    "minCents" INTEGER,
    "maxCents" INTEGER,
    "action" TEXT NOT NULL,
    "costCategory" TEXT,
    "business" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MatchRule_userId_enabled_idx" ON "MatchRule"("userId", "enabled");

-- Undoing a rule or auto match must stick: rows with noRule are skipped by rules.
ALTER TABLE "BankTransaction" ADD COLUMN "noRule" BOOLEAN NOT NULL DEFAULT false;
