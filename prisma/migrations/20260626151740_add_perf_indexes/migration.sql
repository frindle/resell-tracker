-- CreateIndex
CREATE INDEX "GiftCard_ccGiftCardId_idx" ON "GiftCard"("ccGiftCardId");

-- CreateIndex
CREATE INDEX "GiftCard_ccListingId_idx" ON "GiftCard"("ccListingId");

-- CreateIndex
CREATE INDEX "GiftCard_orderId_idx" ON "GiftCard"("orderId");

-- CreateIndex
CREATE INDEX "Order_userId_orderDate_idx" ON "Order"("userId", "orderDate");

-- CreateIndex
CREATE INDEX "Order_userId_trackingSubmittedToBg_idx" ON "Order"("userId", "trackingSubmittedToBg");
