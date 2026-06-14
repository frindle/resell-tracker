-- CreateTable
CREATE TABLE "PortalRate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "merchant" TEXT NOT NULL,
    "category" TEXT,
    "portal" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PortalRate_merchant_idx" ON "PortalRate"("merchant");
