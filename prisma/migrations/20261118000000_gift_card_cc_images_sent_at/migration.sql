-- Additive only: when a card's photos were sent to CardCenter.
ALTER TABLE "GiftCard" ADD COLUMN "ccImagesSentAt" DATETIME;
-- Failed photo sends, so the backfill gives up on a card after a few tries.
ALTER TABLE "GiftCard" ADD COLUMN "ccImagesFails" INTEGER NOT NULL DEFAULT 0;
