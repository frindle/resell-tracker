-- CreateTable
CREATE TABLE "CarrierDelivery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "carrier" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "deliveredAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT NOT NULL,
    "checkedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CarrierDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CarrierDelivery_userId_status_idx" ON "CarrierDelivery"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierDelivery_userId_trackingNumber_key" ON "CarrierDelivery"("userId", "trackingNumber");
