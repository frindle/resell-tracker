-- Waitlist for unsold gift cards: park a card with a target sell rate and a
-- deadline, and let the runner submit it when CardCenter's rate for that brand
-- and denomination reaches the target.
--
-- No new table: the waitlist is a property of the card, and "unsold" is already
-- exactly `ccSubmittedAt IS NULL`. A card is ON the waitlist when both
-- waitlistTargetRate and waitlistMaxDate are set and it is still unsold.
ALTER TABLE "GiftCard" ADD COLUMN "waitlistTargetRate" REAL;
ALTER TABLE "GiftCard" ADD COLUMN "waitlistMaxDate" TEXT;
ALTER TABLE "GiftCard" ADD COLUMN "waitlistStatus" TEXT;
ALTER TABLE "GiftCard" ADD COLUMN "waitlistUpdatedAt" DATETIME;
