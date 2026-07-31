-- CreateTable
CREATE TABLE "BfmrSubmittedShipment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "reservationId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BfmrSubmittedShipment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "BfmrReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BfmrSubmittedShipment_reservationId_idx" ON "BfmrSubmittedShipment"("reservationId");
