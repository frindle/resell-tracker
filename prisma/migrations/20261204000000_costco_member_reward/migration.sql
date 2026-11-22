-- Costco Executive membership reward (lib/costcoReward.ts).
ALTER TABLE "Order" ADD COLUMN "merchandiseSubtotal" REAL;
ALTER TABLE "Order" ADD COLUMN "memberReward" REAL;

-- Existing Costco orders: 2% of cost less known tax, less returned units (no subtotal has been read for them yet).
UPDATE "Order"
-- The base is rounded to cents before the 2% is taken, the way costcoRewardBase does it.
SET "memberReward" = ROUND(ROUND(
  MAX("cost" - COALESCE("taxAmount", 0), 0)
  * (CASE WHEN "returnedCost" > 0 AND "cost" > 0 THEN MAX(1 - "returnedCost" / "cost", 0) ELSE 1 END)
  , 2) * 0.02, 2)
WHERE LOWER(TRIM("platform")) = 'costco' AND "cancelled" = 0;
