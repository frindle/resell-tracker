-- BuyingGroup tiered payouts (lib/bgPayoutTiers.ts).
ALTER TABLE "BuyingGroupCommitment" ADD COLUMN "fulfilledAt" DATETIME;
ALTER TABLE "BuyingGroupCommitment" ADD COLUMN "tierShortAt" DATETIME;
