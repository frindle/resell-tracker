# REPO_MAP

Auto-generated localization aid for this diagnosis. Consult this FIRST to find WHERE code lives, then open only the few files you need. Do not grep blind -- grep only to confirm a location this map already points to.

## Symbol index (file -> exported / top-level symbols)

### (root)
- `check_literals.py`: TARGET (const), LITERALS (const), _parse_must_contain (def), _norm (def), _body (def)
- `eslint.config.mjs`: default (export)
- `instrumentation.ts`: register (fn)
- `next.config.ts`: default (export)
- `postcss.config.mjs`: default (export)
- `prisma.config.ts`: default (export)
- `proxy.ts`: middleware (fn), config (const)

### app
- `app/layout.tsx`: metadata (const), RootLayout (fn)
- `app/page.tsx`: dynamic (const), DashboardPage (fn)

### app/analytics
- `app/analytics/page.tsx`: AnalyticsPage (fn)

### app/api-errors
- `app/api-errors/page.tsx`: ApiErrorsPage (fn)

### app/api/admin/reset-delivery-photos
- `app/api/admin/reset-delivery-photos/route.ts`: POST (fn)

### app/api/analytics
- `app/api/analytics/route.ts`: GET (fn)

### app/api/api-errors
- `app/api/api-errors/route.ts`: dynamic (const), POST (fn), GET (fn), DELETE (fn)

### app/api/api-errors/unread-count
- `app/api/api-errors/unread-count/route.ts`: dynamic (const), GET (fn), POST (fn)

### app/api/auth/login
- `app/api/auth/login/route.ts`: POST (fn), GET (fn)

### app/api/auth/logout
- `app/api/auth/logout/route.ts`: POST (fn)

### app/api/auth/me
- `app/api/auth/me/route.ts`: GET (fn)

### app/api/auth/users
- `app/api/auth/users/route.ts`: GET (fn)

### app/api/bfmr/cancel-reservation
- `app/api/bfmr/cancel-reservation/route.ts`: POST (fn)

### app/api/bfmr/deal-items
- `app/api/bfmr/deal-items/route.ts`: GET (fn)

### app/api/bfmr/deals
- `app/api/bfmr/deals/route.ts`: GET (fn)

### app/api/bfmr/full-sync
- `app/api/bfmr/full-sync/route.ts`: POST (fn)

### app/api/bfmr/links
- `app/api/bfmr/links/route.ts`: dynamic (const), GET (fn), POST (fn)

### app/api/bfmr/links/[id]
- `app/api/bfmr/links/[id]/route.ts`: dynamic (const), DELETE (fn), PATCH (fn)

### app/api/bfmr/links/split
- `app/api/bfmr/links/split/route.ts`: dynamic (const), POST (fn)

### app/api/bfmr/order-map
- `app/api/bfmr/order-map/route.ts`: dynamic (const), GET (fn)

### app/api/bfmr/push-tracking
- `app/api/bfmr/push-tracking/route.ts`: POST (fn)

### app/api/bfmr/rejected-items
- `app/api/bfmr/rejected-items/route.ts`: GET (fn)

### app/api/bfmr/reservations
- `app/api/bfmr/reservations/route.ts`: dynamic (const), GET (fn)

### app/api/bfmr/reservations/[id]/submitted-shipments
- `app/api/bfmr/reservations/[id]/submitted-shipments/route.ts`: dynamic (const), DELETE (fn)

### app/api/bfmr/reserve
- `app/api/bfmr/reserve/route.ts`: POST (fn)

### app/api/bfmr/resolve-link
- `app/api/bfmr/resolve-link/route.ts`: GET (fn)

### app/api/bfmr/submit-reservation-tracking
- `app/api/bfmr/submit-reservation-tracking/route.ts`: POST (fn)

### app/api/bfmr/sync-orders
- `app/api/bfmr/sync-orders/route.ts`: POST (fn)

### app/api/bfmr/sync-reservations
- `app/api/bfmr/sync-reservations/route.ts`: dynamic (const), POST (fn)

### app/api/bfmr/test
- `app/api/bfmr/test/route.ts`: POST (fn), GET (fn)

### app/api/bfmr/tracker
- `app/api/bfmr/tracker/route.ts`: GET (fn)

### app/api/bfmr/vendors
- `app/api/bfmr/vendors/route.ts`: GET (fn)

### app/api/bfmr/watchers
- `app/api/bfmr/watchers/route.ts`: GET (fn), POST (fn)

### app/api/bfmr/watchers/[id]
- `app/api/bfmr/watchers/[id]/route.ts`: DELETE (fn), PATCH (fn)

### app/api/bfmr/web-login
- `app/api/bfmr/web-login/route.ts`: POST (fn)

### app/api/bg/backfill-tracking
- `app/api/bg/backfill-tracking/route.ts`: POST (fn)

### app/api/bigsky/auth/send-otp
- `app/api/bigsky/auth/send-otp/route.ts`: POST (fn)

### app/api/bigsky/auth/verify-otp
- `app/api/bigsky/auth/verify-otp/route.ts`: POST (fn)

### app/api/bigsky/sync-orders
- `app/api/bigsky/sync-orders/route.ts`: POST (fn)

### app/api/blocked-addresses
- `app/api/blocked-addresses/route.ts`: GET (fn), POST (fn)

### app/api/blocked-addresses/[id]
- `app/api/blocked-addresses/[id]/route.ts`: DELETE (fn)

### app/api/blocked-addresses/apply
- `app/api/blocked-addresses/apply/route.ts`: POST (fn)

### app/api/buyers
- `app/api/buyers/route.ts`: GET (fn), POST (fn)

### app/api/buyers/[id]
- `app/api/buyers/[id]/route.ts`: DELETE (fn)

### app/api/buyers/[id]/orders
- `app/api/buyers/[id]/orders/route.ts`: GET (fn)

### app/api/buyinggroup/commitment
- `app/api/buyinggroup/commitment/route.ts`: POST (fn), DELETE (fn)

### app/api/buyinggroup/commitment/items
- `app/api/buyinggroup/commitment/items/route.ts`: GET (fn)

### app/api/buyinggroup/commitment/list
- `app/api/buyinggroup/commitment/list/route.ts`: GET (fn)

### app/api/buyinggroup/commitments
- `app/api/buyinggroup/commitments/route.ts`: dynamic (const), GET (fn)

### app/api/buyinggroup/deals
- `app/api/buyinggroup/deals/route.ts`: GET (fn)

### app/api/buyinggroup/deals/history
- `app/api/buyinggroup/deals/history/route.ts`: GET (fn)

### app/api/buyinggroup/debug
- `app/api/buyinggroup/debug/route.ts`: GET (fn)

### app/api/buyinggroup/links
- `app/api/buyinggroup/links/route.ts`: dynamic (const), POST (fn)

### app/api/buyinggroup/links/[id]
- `app/api/buyinggroup/links/[id]/route.ts`: dynamic (const), DELETE (fn)

### app/api/buyinggroup/login
- `app/api/buyinggroup/login/route.ts`: GET (fn), POST (fn)

### app/api/buyinggroup/order-payouts
- `app/api/buyinggroup/order-payouts/route.ts`: GET (fn)

### app/api/buyinggroup/orders
- `app/api/buyinggroup/orders/route.ts`: GET (fn)

### app/api/buyinggroup/pending-orders
- `app/api/buyinggroup/pending-orders/route.ts`: GET (fn)

### app/api/buyinggroup/receipts
- `app/api/buyinggroup/receipts/route.ts`: GET (fn)

### app/api/buyinggroup/resolve-order
- `app/api/buyinggroup/resolve-order/route.ts`: GET (fn), POST (fn), DELETE (fn)

### app/api/buyinggroup/sync-commitments
- `app/api/buyinggroup/sync-commitments/route.ts`: dynamic (const), POST (fn)

### app/api/buyinggroup/sync-orders
- `app/api/buyinggroup/sync-orders/route.ts`: POST (fn)

### app/api/buyinggroup/token
- `app/api/buyinggroup/token/route.ts`: GET (fn)

### app/api/buyinggroup/tracking-orders
- `app/api/buyinggroup/tracking-orders/route.ts`: GET (fn)

### app/api/cardcenter/brands
- `app/api/cardcenter/brands/route.ts`: GET (fn)

### app/api/cardcenter/buy-orders
- `app/api/cardcenter/buy-orders/route.ts`: GET (fn)

### app/api/cardcenter/fulfill-reservation
- `app/api/cardcenter/fulfill-reservation/route.ts`: POST (fn)

### app/api/cardcenter/payments
- `app/api/cardcenter/payments/route.ts`: GET (fn)

### app/api/cardcenter/payments/[id]
- `app/api/cardcenter/payments/[id]/route.ts`: GET (fn)

### app/api/cardcenter/rates
- `app/api/cardcenter/rates/route.ts`: GET (fn)

### app/api/cardcenter/reservations
- `app/api/cardcenter/reservations/route.ts`: GET (fn)

### app/api/cardcenter/reservations/[id]
- `app/api/cardcenter/reservations/[id]/route.ts`: DELETE (fn)

### app/api/cardcenter/reserve
- `app/api/cardcenter/reserve/route.ts`: POST (fn)

### app/api/cardcenter/reserve-only
- `app/api/cardcenter/reserve-only/route.ts`: POST (fn)

### app/api/cardcenter/submit
- `app/api/cardcenter/submit/route.ts`: POST (fn)

### app/api/cardcenter/sync-payment
- `app/api/cardcenter/sync-payment/route.ts`: POST (fn)

### app/api/cardcenter/sync-payments
- `app/api/cardcenter/sync-payments/route.ts`: POST (fn)

### app/api/cardcenter/test
- `app/api/cardcenter/test/route.ts`: POST (fn), GET (fn)

### app/api/cards
- `app/api/cards/route.ts`: GET (fn), POST (fn)

### app/api/cards/[id]
- `app/api/cards/[id]/route.ts`: PUT (fn), DELETE (fn)

### app/api/cards/merchant-rates
- `app/api/cards/merchant-rates/route.ts`: POST (fn)

### app/api/cards/merchant-rates/[id]
- `app/api/cards/merchant-rates/[id]/route.ts`: DELETE (fn)

### app/api/costco/receipts
- `app/api/costco/receipts/route.ts`: POST (fn), GET (fn)

### app/api/costco/receipts/[barcode]/link
- `app/api/costco/receipts/[barcode]/link/route.ts`: POST (fn), DELETE (fn)

### app/api/costco/receipts/clear
- `app/api/costco/receipts/clear/route.ts`: POST (fn)

### app/api/email/delete
- `app/api/email/delete/route.ts`: POST (fn)

### app/api/email/sync
- `app/api/email/sync/route.ts`: GET (fn)

### app/api/email/test
- `app/api/email/test/route.ts`: POST (fn)

### app/api/extension/commands
- `app/api/extension/commands/route.ts`: dynamic (const), GET (fn), POST (fn)

### app/api/extension/commands/[id]
- `app/api/extension/commands/[id]/route.ts`: PATCH (fn), DELETE (fn)

### app/api/giftcard-ocr
- `app/api/giftcard-ocr/route.ts`: GET (fn), POST (fn)

### app/api/giftcard-ocr/orders/[id]
- `app/api/giftcard-ocr/orders/[id]/route.ts`: GET (fn)

### app/api/giftcard-ocr/orders/[id]/apply
- `app/api/giftcard-ocr/orders/[id]/apply/route.ts`: POST (fn)

### app/api/giftcard-ocr/orders/[id]/preview/[attachmentId]
- `app/api/giftcard-ocr/orders/[id]/preview/[attachmentId]/route.ts`: GET (fn)

### app/api/import
- `app/api/import/route.ts`: OPTIONS (fn), POST (fn)

### app/api/orders
- `app/api/orders/route.ts`: GET (fn), DELETE (fn), POST (fn)

### app/api/orders/[id]
- `app/api/orders/[id]/route.ts`: GET (fn), PUT (fn), PATCH (fn), DELETE (fn)

### app/api/orders/[id]/attachments
- `app/api/orders/[id]/attachments/route.ts`: POST (fn), GET (fn), DELETE (fn)

### app/api/orders/[id]/attachments/[attachmentId]
- `app/api/orders/[id]/attachments/[attachmentId]/route.ts`: GET (fn)

### app/api/orders/[id]/cancel
- `app/api/orders/[id]/cancel/route.ts`: POST (fn)

### app/api/orders/[id]/gift-cards
- `app/api/orders/[id]/gift-cards/route.ts`: GET (fn), POST (fn), PATCH (fn), DELETE (fn)

### app/api/orders/[id]/lock
- `app/api/orders/[id]/lock/route.ts`: POST (fn), DELETE (fn)

### app/api/orders/[id]/returns
- `app/api/orders/[id]/returns/route.ts`: GET (fn), POST (fn), PATCH (fn), DELETE (fn)

### app/api/orders/apply-rules
- `app/api/orders/apply-rules/route.ts`: POST (fn)

### app/api/orders/attachments/bulk
- `app/api/orders/attachments/bulk/route.ts`: POST (fn)

### app/api/orders/attachments/unassigned
- `app/api/orders/attachments/unassigned/route.ts`: GET (fn)

### app/api/orders/attachments/unassigned/[attachmentId]
- `app/api/orders/attachments/unassigned/[attachmentId]/route.ts`: GET (fn), DELETE (fn), PATCH (fn)

### app/api/orders/backfill
- `app/api/orders/backfill/route.ts`: dynamic (const), GET (fn), OPTIONS (fn)

### app/api/orders/batch-delete
- `app/api/orders/batch-delete/route.ts`: POST (fn)

### app/api/orders/blocked
- `app/api/orders/blocked/route.ts`: dynamic (const), GET (fn), POST (fn)

### app/api/orders/cleanup-fake-tracking
- `app/api/orders/cleanup-fake-tracking/route.ts`: dynamic (const), GET (fn), POST (fn)

### app/api/orders/locked-order-numbers
- `app/api/orders/locked-order-numbers/route.ts`: dynamic (const), GET (fn)

### app/api/orders/missing-tracking
- `app/api/orders/missing-tracking/route.ts`: GET (fn)

### app/api/orders/platforms
- `app/api/orders/platforms/route.ts`: GET (fn)

### app/api/orders/submit-tracking
- `app/api/orders/submit-tracking/route.ts`: POST (fn)

### app/api/portal-rates
- `app/api/portal-rates/route.ts`: GET (fn), POST (fn)

### app/api/portal-rates/[id]
- `app/api/portal-rates/[id]/route.ts`: DELETE (fn)

### app/api/portal-rates/bulk
- `app/api/portal-rates/bulk/route.ts`: POST (fn)

### app/api/pushover/test
- `app/api/pushover/test/route.ts`: POST (fn)

### app/api/sender-rules
- `app/api/sender-rules/route.ts`: GET (fn), POST (fn)

### app/api/sender-rules/[id]
- `app/api/sender-rules/[id]/route.ts`: DELETE (fn)

### app/api/settings
- `app/api/settings/route.ts`: dynamic (const), GET (fn), POST (fn)

### app/api/shipping-rules
- `app/api/shipping-rules/route.ts`: GET (fn), POST (fn)

### app/api/shipping-rules/[id]
- `app/api/shipping-rules/[id]/route.ts`: DELETE (fn), PATCH (fn)

### app/api/sidecar/info
- `app/api/sidecar/info/route.ts`: GET (fn)

### app/api/sidecar/vnc-passwords
- `app/api/sidecar/vnc-passwords/route.ts`: dynamic (const), GET (fn)

### app/api/sync-history
- `app/api/sync-history/route.ts`: dynamic (const), GET (fn)

### app/api/users
- `app/api/users/route.ts`: OPTIONS (fn), GET (fn), POST (fn), PUT (fn)

### app/api/users/[id]
- `app/api/users/[id]/route.ts`: PATCH (fn), DELETE (fn)

### app/api/version
- `app/api/version/route.ts`: dynamic (const), GET (fn)

### app/bfmr
- `app/bfmr/layout.tsx`: BfmrLayout (fn)
- `app/bfmr/page.tsx`: BfmrPage (fn)

### app/bfmr/deals
- `app/bfmr/deals/page.tsx`: DealsPage (fn)

### app/bfmr/reservations
- `app/bfmr/reservations/page.tsx`: ReservationsPage (fn)

### app/bfmr/watcher
- `app/bfmr/watcher/page.tsx`: WatcherPage (fn)

### app/buyers
- `app/buyers/page.tsx`: BuyersPage (fn)

### app/buyinggroup
- `app/buyinggroup/layout.tsx`: BuyingGroupLayout (fn)
- `app/buyinggroup/page.tsx`: BuyingGroupPage (fn)

### app/buyinggroup/commitments
- `app/buyinggroup/commitments/page.tsx`: CommitmentsPage (fn)

### app/buyinggroup/deals
- `app/buyinggroup/deals/page.tsx`: BgDealsPage (fn)

### app/cardcenter
- `app/cardcenter/layout.tsx`: CardCenterLayout (fn)
- `app/cardcenter/page.tsx`: CardCenterPage (fn)

### app/cardcenter/rates
- `app/cardcenter/rates/page.tsx`: RatesPage (fn)

### app/cards
- `app/cards/page.tsx`: CardsPage (fn)

### app/costco
- `app/costco/ClearReceiptsButton.tsx`: ClearReceiptsButton (fn)
- `app/costco/page.tsx`: CostcoDebugPage (fn)

### app/import
- `app/import/page.tsx`: ImportPage (fn)

### app/login
- `app/login/page.tsx`: LoginPage (fn)

### app/orders
- `app/orders/page.tsx`: OrdersPage (fn)

### app/orders/[id]
- `app/orders/[id]/page.tsx`: dynamic (const), EditOrderPage (fn)

### app/orders/[id]/giftcard-ocr
- `app/orders/[id]/giftcard-ocr/page.tsx`: GiftCardOcrPage (fn)

### app/orders/blocked
- `app/orders/blocked/page.tsx`: BlockedOrdersPage (fn)

### app/orders/bulk-upload
- `app/orders/bulk-upload/page.tsx`: BulkUploadPage (fn)

### app/orders/new
- `app/orders/new/page.tsx`: NewOrderPage (fn)

### app/orders/sort-assign
- `app/orders/sort-assign/page.tsx`: SortAssignPage (fn)

### app/settings
- `app/settings/page.tsx`: SettingsPage (fn)

### app/sync-history
- `app/sync-history/page.tsx`: SyncHistoryPage (fn)

### components
- `components/BfmrNav.tsx`: BfmrNav (fn)
- `components/BfmrReservationLinker.tsx`: BfmrReservationLinker (fn)
- `components/BgCommitmentLinker.tsx`: BgCommitmentLinker (fn)
- `components/BuyingGroupNav.tsx`: BuyingGroupNav (fn)
- `components/CardCenterNav.tsx`: CardCenterNav (fn)
- `components/CommitNumberInput.tsx`: CommitNumberInput (fn)
- `components/CostcoReceiptLinker.tsx`: CostcoReceiptLinker (fn)
- `components/EmailImport.tsx`: EmailImport (fn)
- `components/FirefoxInputGuard.tsx`: FirefoxInputGuard (fn)
- `components/GiftCardOcrReview.tsx`: GiftCardOcrReview (fn)
- `components/GiftCards.tsx`: GiftCards (fn)
- `components/LockButton.tsx`: LockButton (fn)
- `components/NavBar.tsx`: NavBar (fn)
- `components/OrderAttachments.tsx`: OrderAttachments (fn)
- `components/OrderDetailShell.tsx`: OrderDetailShell (fn)
- `components/OrderForm.tsx`: default (export)
- `components/PaymentInfo.tsx`: PaymentInfo (fn)
- `components/QuarantineBanner.tsx`: QuarantineBanner (fn)
- `components/ReturnPanel.tsx`: ReturnPanel (fn)
- `components/SyncStatusIndicator.tsx`: SyncStatusIndicator (fn)
- `components/UserMenu.tsx`: UserMenu (fn)

### docker
- `docker/critical-exit.py`: CRITICAL (const), GRACE_SECONDS (const), SELF (const), log (def), bring_down (def), main (def)

### giftcard-ocr
- `giftcard-ocr/engine.py`: DEFAULT_VARIANTS (const), MODEL_SETS (const), Engine (class)
- `giftcard-ocr/pins.py`: PIN_LENS (const), norm (def), _rect (def), group_lines (def), extract_candidates_with_regions (def), extract_candidates (def), window_candidates (def)
- `giftcard-ocr/preload.py`: _sample_png (def), main (def)
- `giftcard-ocr/server.py`: MAX_BYTES (const), ENGINE (const), CONFIGURED_VARIANTS (const), SECRET (const), _authorised (def), _truthy (def), _image_bytes (def), health (def), ocr (def)
- `giftcard-ocr/variants.py`: DEFAULT_LONG_EDGE (const), _arr (def), _img (def), _channel_broadcast (def), _mono (def), _kelvin_rgb (def), _temperature (def), _gamma (def), _hue (def), _scale (def), _affine (def), OPS (const), ...(+6 more)

### lib
- `lib/analytics.ts`: getRange (fn), getPriorYearRange (fn), calcMiles (fn), centsPerPoint (fn), calcStats (fn), PERIOD_LABELS (const)
- `lib/apiCallLog.ts`: logApiCall (fn), loggedFetch (fn), pruneApiCallLog (fn), startApiCallLogRetention (fn)
- `lib/apiErrorLog.ts`: logApiError (fn)
- `lib/apiResponse.ts`: readApiResponse (fn), mayHaveTakenEffect (fn)
- `lib/auth.ts`: buildSessionCookie (fn), clearSessionCookie (fn), getSessionUserId (fn), getSessionUser (fn)
- `lib/autoSubmitChannel.ts`: autoSubmitChannel (fn)
- `lib/autoSubmitTracking.ts`: autoSubmitTrackingForOrders (fn)
- `lib/autoSync.ts`: runAutoSync (fn), startAutoSync (fn)
- `lib/bfmr.ts`: BFMR_STATUS_RANK (const), BFMR_TERMINAL_STATUSES (const), deriveBfmrStatus (fn), computeBfmrPaidRollup (fn), testConnection (fn), getMyTracker (fn), getMyTrackerAll (fn), updateTracker (fn), getDeals (fn), getDeal (fn), getActiveReservations (fn), getShipmentStatus (fn), ...(+3 more)
- `lib/bfmrAutoLink.ts`: autoLinkBfmrReservations (fn), applySubmittedTrackingToLinks (fn)
- `lib/bfmrAutoSync.ts`: shouldAutoSync (fn), parseExpectedItemCount (fn), isFullyAccounted (fn), shouldAutoSyncForOrder (fn)
- `lib/bfmrJoin.ts`: normalizeBfmrTimestamp (fn), bfmrJoinKey (fn), buildOrderIdTrackerRow (fn)
- `lib/bfmrLinkGuard.ts`: normTracking (fn), splitSiblingCoverage (fn), staleSiblingAdjustments (fn), guardLink (fn)
- `lib/bfmrLinkSubmission.ts`: linkSubmissionState (fn)
- `lib/bfmrLinkValue.ts`: expectedLinkValue (fn), linkDisplayValue (fn), linkValueDivergence (fn)
- `lib/bfmrPushGate.ts`: isPartialLink (fn), shouldPushOrderNumber (fn)
- `lib/bfmrReservationLineKey.ts`: reservationLineKey (fn), dedupeReservationLines (fn)
- `lib/bfmrSalePrice.ts`: findStaleBfmrLinkValues (fn), recalcBfmrSalePrice (fn)
- `lib/bfmrSubmitFlow.ts`: isAlreadyRecorded (fn), submitAndReconcile (fn)
- `lib/bfmrVerify.ts`: ALL_WEB_STATUSES (const), WEB_BACKFILL_FETCH (const), classifyVerify (fn), verifySubmission (fn)
- `lib/bfmrWatcher.ts`: startWatcher (fn)
- `lib/bfmrWeb.ts`: getWebTrackerRows (fn), getProfile (fn), getDeals (fn), getDealItems (fn), checkAndReserve (fn), submitTracking (fn), BfmrNotSubmittedError (class), submitTrackingForReservation (fn), reconcileReservationSubmission (fn), pushReservationOrderNumber (fn), cancelReservation (fn)
- `lib/bgAuth.ts`: getBgAccessToken (fn), isBgConfigured (fn)
- `lib/bgCredited.ts`: isOrderFullyCredited (fn)
- `lib/bgSync.ts`: runBgReceiptSync (fn)
- `lib/bigsky.ts`: sendBigSkyOtp (fn), verifyBigSkyOtp (fn), bigSkyCookieValid (fn), fetchScanItems (fn), fetchNotCheckedInTracking (fn), submitTracking (fn)
- `lib/bigskyHealth.ts`: checkBigSkySessions (fn), startBigSkyHealthCheck (fn)
- `lib/buyinggroup.ts`: extractTokens (fn), login (fn), refreshAccessToken (fn), getPayments (fn), getReceipts (fn), getReceiptDetails (fn), getOrders (fn), submitTracking (fn), getDeals (fn), getStatistics (fn), getBalance (fn), getCommitmentItems (fn), ...(+3 more)
- `lib/cardcenter.ts`: errCause (fn), ccFetch (fn), findDuplicateCardCodes (fn), ccJson (fn), ccApiFetch (fn), getPaymentDetail (fn), submitCards (fn)
- `lib/carrier.ts`: carrierFromTrackingNumber (fn)
- `lib/cashback.ts`: computeCashback (fn)
- `lib/commitmentSalePrice.ts`: recalcSalePrice (fn)
- `lib/costcoReceipt.ts`: generateReceiptPdf (fn)
- `lib/csvParsers.ts`: parseCSV (fn), detectPlatform (fn), isAddressBlocked (fn), parseAmazonCSV (fn), parseWalmartCSV (fn), autoParseCSV (fn)
- `lib/dateWindow.ts`: DATE_WINDOWS (const), windowStartDate (fn), windowStartIso (fn)
- `lib/db.ts`: prisma (const), getSetting (fn), upsertSetting (fn)
- `lib/dbBackup.ts`: runDbBackup (fn), startDbBackup (fn)
- `lib/deadlineReminders.ts`: runDeadlineCheck (fn), startDeadlineReminders (fn)
- `lib/deliveryPhoto.ts`: captureDeliveryPhoto (fn)
- `lib/emailSync.ts`: fetchOrderEmails (fn), deleteEmail (fn), deleteEmails (fn)
- `lib/extensionAuth.ts`: verifyExtensionSecret (fn), resolveExtensionUserId (fn)
- `lib/extensionCommandTargeting.ts`: extensionCommandTargetFilter (fn), callerCanClaim (fn)
- `lib/formatOrderDate.ts`: isDateOnlyOrderDate (fn), formatOrderDate (fn), formatOrderDateIso (fn), toOrderDateInputValue (fn), fromOrderDateInputValue (fn)
- `lib/giftCardOcr.ts`: GiftCardOcrDisabledError (class), isGiftCardOcrEnabled (fn), giftCardOcrGate (fn), rotateRegion (fn), giftCardOcrUrl (fn), readGiftCardImage (fn), giftCardOcrHealth (fn)
- `lib/giftCardOcrVerify.ts`: ACTIONABLE_VERDICTS (const), normalizeCode (fn), receiptMarkers (fn), looksLikeReceipt (fn), editDistance (fn), checkCardAgainstOcr (fn), auditFor (fn), verifyOrderCards (fn)
- `lib/orderLock.ts`: requireOrderUnlocked (fn)
- `lib/orderReturns.ts`: proratedLinkValue (fn), returnedCostFor (fn), clampReturnsToLines (fn), lineKeyOf (fn), getReturnableLines (fn), returnedUnitsByLine (fn), recalcReturnedCost (fn), recalcAfterReturnChange (fn), mapAmazonReturnStatus (fn)
- `lib/overdue.ts`: localDateStr (fn), isOverdue (fn)
- `lib/paymentStatus.ts`: PROCESSED_STATUSES (const), fullyReturned (fn), paymentStatus (fn)
- `lib/pushover.ts`: sendPushover (fn)
- `lib/returnStatus.ts`: RETURN_STATUSES (const), RETURN_STATUS_LABELS (const), isReturnStatus (fn), OPEN_RETURN_STATUSES (const), hasOpenReturns (fn), isFullyReturned (fn)
- `lib/secrets.ts`: SENSITIVE_SETTING_KEYS (const), isEncrypted (fn), encryptSetting (fn), decryptSetting (fn)
- `lib/syncStatus.ts`: commandLabel (fn), isActiveCommand (const), isFinishedCommand (const), STATUS_WORD (const), relativeTime (fn), summarizeResult (fn), isSessionExpiredResult (fn), visibleCommands (fn)
- `lib/thumbnail.ts`: THUMB_SIZE (const), UNASSIGNED_THUMB_DIR (const), unassignedThumbPath (fn), makeUnrotatedThumbnail (fn), rotateThumbnail (fn), makeThumbnail (fn)
- `lib/trustBrowser.ts`: TRUST_COOKIE (const), TRUST_MAX_AGE_SECONDS (const), buildTrustCookie (fn), clearTrustCookie (fn), trustUserIdFor (fn), isTrustedBrowser (fn)
- `lib/useHideCashback.ts`: useHideCashback (fn)

## Computation digest (where quantities/totals/counts are computed)

Grep-built list of sums/reduces/totals -- the classic 'where is X computed' hits. file:line -> code.

- `app/page.tsx:26` -> `prisma.order.findMany({ where: { ...userFilter }, include: { buyer: true, card: { include: { merchan`
- `app/page.tsx:42` -> `const wins = settledOrders.filter(o => o.salePrice! - (o.cost + o.shippingCost + o.insuranceCost - o`
- `app/page.tsx:43` -> `const losses = settledOrders.length - wins;`
- `app/page.tsx:45` -> `// unblocks. They still count in all-time stats above.`
- `app/page.tsx:53` -> `const fullyReturned = (o: { returns: { quantity: number }[]; bfmrLinks: { quantity: number }[]; comm`
- `app/page.tsx:54` -> `isFullyReturned(o.returns, [...o.bfmrLinks.map(l => l.quantity), ...o.commitmentLinks.map(l => l.qua`
- `app/page.tsx:56` -> `type Owed = { group: string; count: number; outstanding: number; overdue: number };`
- `app/page.tsx:64` -> `const entry = owedMap.get(o.buyer.name) ?? { group: o.buyer.name, count: 0, outstanding: 0, overdue:`
- `app/page.tsx:65` -> `entry.count++;`
- `app/page.tsx:66` -> `entry.outstanding += due;`
- `app/page.tsx:67` -> `if (o.overdueAt && isOverdue(o.overdueAt) && !o.bgCredited && !(o.bfmrStatus && PROCESSED_STATUSES.h`
- `app/page.tsx:71` -> `const totalOwed = owedByGroup.reduce((s, g) => s + g.outstanding, 0);`
- `app/page.tsx:72` -> `const totalOverdue = owedByGroup.reduce((s, g) => s + g.overdue, 0);`
- `app/page.tsx:76` -> `const needsInfoCount = allOrders.filter(o => !o.lost && !o.cancelled && !o.blockedAddressPattern && `
- `app/page.tsx:86` -> `}).length;`
- `app/page.tsx:90` -> `try { const items = JSON.parse(o.bfmrRejectedItems); return Array.isArray(items) && items.length > 0`
- `app/page.tsx:91` -> `}).length;`
- `app/page.tsx:92` -> `const blockedCount = allOrders.filter(o => o.blockedAddressPattern).length;`
- `app/page.tsx:121` -> `<StatCard label="Orders" value={String(allOrders.length)} sub={`${wins}W / ${losses}L`} />`
- `app/page.tsx:150` -> `{owedByGroup.length > 0 && (`
- `app/page.tsx:173` -> `<td className="px-4 py-2.5 text-right text-gray-400">{g.count}</td>`
- `app/page.tsx:191` -> `{recent.length === 0 ? (`
- `app/page.tsx:214` -> `// cost basis too or a return reads as a total loss.`
- `app/settings/page.tsx:252` -> `if (vncPassword.length < 6) return;`
- `app/settings/page.tsx:781` -> `{portalRates.length > 0 && (`
- `app/settings/page.tsx:837` -> `if (!knownPortals.length) return null;`
- `app/settings/page.tsx:896` -> `{extCmds.length > 0 && (`
- `app/settings/page.tsx:953` -> `<button onClick={saveVnc} disabled={vncPassword.length < 6}`
- `app/settings/page.tsx:959` -> `{vncPassword.length > 0 && vncPassword.length < 6 && (`

...(REPO_MAP truncated at the line cap -- it is a summary, not a full listing)
