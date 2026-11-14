-- Additive only: which buyer a deposit description belongs to (Books P3 step 3c).
CREATE TABLE "PayeeAlias" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "buyerId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PayeeAlias_userId_token_key" ON "PayeeAlias"("userId", "token");
CREATE INDEX "PayeeAlias_buyerId_idx" ON "PayeeAlias"("buyerId");
