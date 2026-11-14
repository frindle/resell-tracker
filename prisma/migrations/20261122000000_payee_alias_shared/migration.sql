-- A payer name accepted for two different buyers is shared: buyerId NULL, and it no longer narrows deposits.
-- SQLite cannot drop NOT NULL in place, so the table is rebuilt (rows kept as they are).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PayeeAlias" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "buyerId" INTEGER,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_PayeeAlias" ("id", "userId", "buyerId", "token", "createdAt") SELECT "id", "userId", "buyerId", "token", "createdAt" FROM "PayeeAlias";
DROP TABLE "PayeeAlias";
ALTER TABLE "new_PayeeAlias" RENAME TO "PayeeAlias";
CREATE UNIQUE INDEX "PayeeAlias_userId_token_key" ON "PayeeAlias"("userId", "token");
CREATE INDEX "PayeeAlias_buyerId_idx" ON "PayeeAlias"("buyerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
