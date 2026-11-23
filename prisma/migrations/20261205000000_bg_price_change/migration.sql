-- BuyingGroup "Commitment Price Change Scheduled" emails (lib/bgPriceChange.ts).
ALTER TABLE "BuyingGroupCommitment" ADD COLUMN "pendingPrice" REAL;
ALTER TABLE "BuyingGroupCommitment" ADD COLUMN "pendingCommission" REAL;
ALTER TABLE "BuyingGroupCommitment" ADD COLUMN "pendingAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "belowCostAlert" TEXT;
