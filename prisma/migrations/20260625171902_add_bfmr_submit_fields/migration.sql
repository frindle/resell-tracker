-- BFMR my-tracker POST requires PID/RID/my_tracker_id/item_id/deal_id.
-- We already store PID (purchaseId) and RID (reserveId); add the rest.
ALTER TABLE "BfmrReservation" ADD COLUMN "myTrackerId" INTEGER;
ALTER TABLE "BfmrReservation" ADD COLUMN "itemId" INTEGER;
ALTER TABLE "BfmrReservation" ADD COLUMN "dealId" INTEGER;
