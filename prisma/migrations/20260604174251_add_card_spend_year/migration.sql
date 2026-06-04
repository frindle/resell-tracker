-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CreditCard" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "name" TEXT NOT NULL,
    "milesProgram" TEXT,
    "rewardsRate" REAL,
    "basePointsPerDollar" REAL,
    "spendYearType" TEXT NOT NULL DEFAULT 'calendar',
    "spendYearResetMMDD" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CreditCard" ("basePointsPerDollar", "createdAt", "id", "milesProgram", "name", "rewardsRate", "userId") SELECT "basePointsPerDollar", "createdAt", "id", "milesProgram", "name", "rewardsRate", "userId" FROM "CreditCard";
DROP TABLE "CreditCard";
ALTER TABLE "new_CreditCard" RENAME TO "CreditCard";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
