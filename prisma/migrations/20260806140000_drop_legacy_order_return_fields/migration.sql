-- Retire the legacy whole-order return flow. OrderReturn rows are the only
-- return system now.
--
-- DESTRUCTIVE, and the two column groups are not equally safe:
--
--   terminal states  — 'refunded' already baked its P&L into salePrice (= the
--                      refund) + salePriceSynced, and 'written_off' already
--                      set lost = true. Dropping the columns loses a badge,
--                      not money.
--   in-flight states — 'initiated' / 'shipped' / 'dropped_off' exist ONLY in
--                      these columns. Dropping them destroys the fact that a
--                      return is open.
--
-- So: abort the migration if any in-flight row exists. SQLite has no RAISE
-- outside a trigger, but a CHECK constraint on a temp table fails the whole
-- statement — and Prisma fails the migration — with the offending count.
-- Fix by recording those orders as OrderReturn rows in the UI, then re-running.
CREATE TEMP TABLE _legacy_return_guard (
  in_flight_legacy_returns_must_be_recorded_as_OrderReturn_first INTEGER CHECK (
    in_flight_legacy_returns_must_be_recorded_as_OrderReturn_first = 0
  )
);
INSERT INTO _legacy_return_guard
  SELECT COUNT(*) FROM "Order" WHERE "returnStatus" IN ('initiated', 'shipped', 'dropped_off');
DROP TABLE _legacy_return_guard;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "returnStatus";
ALTER TABLE "Order" DROP COLUMN "returnTracking";
ALTER TABLE "Order" DROP COLUMN "returnShippedAt";
ALTER TABLE "Order" DROP COLUMN "refundAmount";
ALTER TABLE "Order" DROP COLUMN "refundedAt";
