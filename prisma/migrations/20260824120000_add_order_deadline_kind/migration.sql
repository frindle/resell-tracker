-- Order.deliveryDeadline stored only a date, but BG and BFMR mean different
-- things by their deadline: BG = must be DELIVERED by, BFMR = TRACKING must be
-- UPLOADED by. Add an explicit discriminator so the meaning lives on the row
-- instead of being re-guessed from the group at each call site.
ALTER TABLE "Order" ADD COLUMN "deadlineKind" TEXT NOT NULL DEFAULT 'DELIVER_BY';

-- Backfill. Every existing row currently defaults to DELIVER_BY, which is
-- correct for BG (the only writer that ever set deliveryDeadline
-- automatically, from BuyingGroupCommitment.expiryDay). Flip the rows that
-- are really BFMR.
--
-- Authority order:
--   1. OrderBfmrLink  — an explicit link to a BFMR reservation.
--   2. Buyer name     — hand-entered BFMR orders that were never linked.
-- An order linked to a BG commitment is left as DELIVER_BY even if it also
-- has a BFMR link, since the BG delivery obligation is the stricter one.
UPDATE "Order"
SET "deadlineKind" = 'TRACKING_BY'
WHERE "deliveryDeadline" IS NOT NULL
  AND "id" NOT IN (SELECT "orderId" FROM "OrderCommitmentLink")
  AND (
    "id" IN (SELECT "orderId" FROM "OrderBfmrLink")
    OR "buyerId" IN (
      SELECT "id" FROM "Buyer"
      WHERE LOWER("name") LIKE '%bfmr%'
         OR LOWER("name") LIKE '%buy for me retail%'
    )
  );
