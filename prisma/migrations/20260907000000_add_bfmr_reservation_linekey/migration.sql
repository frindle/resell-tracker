-- BFMR split-reservation over-commit fix.
--
-- Problem: BfmrReservation had @@unique([userId, reserveId]). A BFMR
-- reservation SPLIT returns two distinct lines under ONE reserveId, so the
-- upsert in app/api/bfmr/sync-reservations collapsed them into a single row
-- and over-committed the merged qty (live: reserveId 9bUKQUHn8NH5xm5DMXcN_w==
-- landed as one qty=3 row instead of a 2-unit and a 1-unit line).
--
-- Fix: add a stored per-line key and move the unique constraint to
-- (userId, lineKey). lineKey mirrors lib/bfmrReservationLineKey.ts exactly:
--     head = reserveId ?? purchaseId ?? shipmentId   (first non-empty)
--     lineKey = head || '|' || purchaseId || '|' || shipmentId
--
-- PRODUCTION SAFETY: this migration runs via `prisma migrate deploy` on
-- container start (Dockerfile CMD) against the live DB. Steps are ordered so
-- the unique index is created only AFTER every row has a lineKey AND after any
-- pre-existing (userId, lineKey) collision has been disambiguated -- a failed
-- CREATE UNIQUE INDEX would crash-loop the container. No rows are deleted, so
-- no OrderBfmrLink rows are lost to the ON DELETE CASCADE.

-- 1. Add the column nullable (SQLite in-place ALTER; no table rebuild).
ALTER TABLE "BfmrReservation" ADD COLUMN "lineKey" TEXT;

-- 2. Backfill every existing row. NULLIF('') reproduces the JS `||` fallthrough
--    (empty string is falsy) used by reservationLineKey()'s head segment.
UPDATE "BfmrReservation"
SET "lineKey" =
  COALESCE(NULLIF("reserveId", ''), NULLIF("purchaseId", ''), NULLIF("shipmentId", ''), '')
  || '|' || COALESCE("purchaseId", '')
  || '|' || COALESCE("shipmentId", '');

-- 3. Collision guard. With the OLD unique on (userId, reserveId) every non-null
--    reserveId row already has a distinct reserveId per user, so its lineKey
--    (head = reserveId) is distinct too -- measured 0 collisions across 717
--    live rows. The only way two rows can share (userId, lineKey) is multiple
--    rows with a NULL/empty reserveId AND the same purchaseId+shipmentId for
--    one user (SQLite allows multiple NULLs in the old index). Those are the
--    same physical BFMR line; keep the newest (MAX(id)) and suffix the rest so
--    the unique index cannot fail. Suffixed rows re-key to the clean value on
--    the next sync. Non-destructive.
UPDATE "BfmrReservation"
SET "lineKey" = "lineKey" || '#dup' || "id"
WHERE "userId" IS NOT NULL
  AND "id" NOT IN (
    SELECT MAX("id") FROM "BfmrReservation"
    WHERE "userId" IS NOT NULL
    GROUP BY "userId", "lineKey"
  );

-- 4. Swap the unique constraint; keep reserveId queryable via a plain index.
DROP INDEX "BfmrReservation_userId_reserveId_key";
CREATE UNIQUE INDEX "BfmrReservation_userId_lineKey_key" ON "BfmrReservation"("userId", "lineKey");
CREATE INDEX "BfmrReservation_userId_reserveId_idx" ON "BfmrReservation"("userId", "reserveId");
