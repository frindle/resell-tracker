-- CreateTable
CREATE TABLE "CardRateHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cardId" INTEGER NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "rewardsRate" REAL,
    "basePointsPerDollar" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CardRateHistory_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "CreditCard" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CardRateHistory_cardId_effectiveFrom_key" ON "CardRateHistory"("cardId", "effectiveFrom");

-- Each card's current rate becomes its first history entry, starting before
-- every order, so every past order still resolves to the rate it has today.
INSERT INTO "CardRateHistory" ("cardId", "effectiveFrom", "rewardsRate", "basePointsPerDollar")
SELECT "id", '0001-01-01', "rewardsRate", "basePointsPerDollar" FROM "CreditCard";
