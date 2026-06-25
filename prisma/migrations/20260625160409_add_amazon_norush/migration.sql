-- Add Amazon No-Rush / delayed-shipping fields to Order
ALTER TABLE "Order" ADD COLUMN "delayedShipping" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "noRushBonusPercent" REAL;
