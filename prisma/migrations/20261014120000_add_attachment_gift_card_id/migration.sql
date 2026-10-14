-- AlterTable
ALTER TABLE "OrderAttachment" ADD COLUMN "giftCardId" INTEGER REFERENCES "GiftCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "OrderAttachment_giftCardId_idx" ON "OrderAttachment"("giftCardId");
