-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PortalRate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "merchant" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "portal" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PortalRate" ("category", "createdAt", "id", "merchant", "portal", "rate", "updatedAt") SELECT coalesce("category", '') AS "category", "createdAt", "id", "merchant", "portal", "rate", "updatedAt" FROM "PortalRate";
DROP TABLE "PortalRate";
ALTER TABLE "new_PortalRate" RENAME TO "PortalRate";
CREATE INDEX "PortalRate_merchant_idx" ON "PortalRate"("merchant");
CREATE UNIQUE INDEX "PortalRate_merchant_portal_category_key" ON "PortalRate"("merchant", "portal", "category");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
