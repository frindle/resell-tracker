-- Additive only: many-to-many photo/card link, per-reservation photo send log, photo content hash.
ALTER TABLE "OrderAttachment" ADD COLUMN "contentHash" TEXT;

CREATE TABLE "GiftCardPhoto" (
    "giftCardId" INTEGER NOT NULL,
    "attachmentId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("giftCardId", "attachmentId"),
    CONSTRAINT "GiftCardPhoto_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GiftCardPhoto_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "OrderAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "GiftCardPhoto_attachmentId_idx" ON "GiftCardPhoto"("attachmentId");

CREATE TABLE "CcPhotoSend" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "attachmentId" INTEGER NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "ccFileId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "cards" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CcPhotoSend_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "OrderAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CcPhotoSend_attachmentId_reservationId_key" ON "CcPhotoSend"("attachmentId", "reservationId");
CREATE INDEX "CcPhotoSend_reservationId_contentHash_idx" ON "CcPhotoSend"("reservationId", "contentHash");
