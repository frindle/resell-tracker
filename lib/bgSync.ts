import { prisma, getSetting } from '@/lib/db';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getAllReceipts, getAllOrders, getPayments, getActivities } from '@/lib/buyinggroup';
import { buildPaymentLedger, receiptCreditsOf, bgRefKey, bgTime, toCents, orderCentsOfReceipts, type PaymentLedger, type ReceiptCredit } from '@/lib/bgPaymentLedger';
import { syncBgReturns } from '@/lib/bgReturnsRun';
import { logApiError } from '@/lib/apiErrorLog';
import { isOrderFullyCredited } from '@/lib/bgCredited';
import { attributeReceipts, isCardCenterBuyer } from '@/lib/bgReceiptAttribution';
import { bgReceiptExpectedPayout } from '@/lib/groupPayoutOwnership';
import { parseUserEditedFields } from '@/lib/orderFieldSync';
import { recordGroupPayment, recordGroupPaymentTotal, commonBuyerId, dayOf } from '@/lib/groupPayments';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export async function runBgReceiptSync(force = false): Promise<{ updated: number; reset: number; failed: number; synced: number; failedUserIds: number[] }> {
  let totalUpdated = 0;
  // Users whose sync finished, and the ones whose threw (so a caller can tell one broken login from a broken run).
  let synced = 0;
  const failedUserIds: number[] = [];
  // Users (or the whole run) whose sync threw: a caller that must not act on a half-done sync checks this.
  let failed = 0;
  const totalReset = 0;
  try {
    // Find all users with BuyingGroup configured
    const users = await prisma.user.findMany({ select: { id: true } });

    for (const user of users) {
      const configured = await isBgConfigured(user.id);
      if (!configured) continue;

      try {
        const token = await getBgAccessToken(user.id);

        const syncStartSetting = await getSetting(user.id, 'bg_sync_start_date');
        const syncStartDate = syncStartSetting?.value ? new Date(syncStartSetting.value) : null;

        const [payments, allReceipts] = await Promise.all([
          getPayments(token),
          getAllReceipts(token) as Promise<unknown[]>,
        ]);

        // The activity feed gives the exact payment -> receipts mapping. A failure never fails the sync: the old heuristic below runs.
        let ledger: PaymentLedger | null = null;
        let ledgerCredits: ReceiptCredit[] = [];
        try {
          const credits = receiptCreditsOf(await getActivities(token));
          const ledgerPays = payments.flatMap(p => {
            const cents = toCents(p.amount), at = bgTime(p.created_dt);
            return cents != null && at != null ? [{ id: String(p.payment_id ?? p.key ?? ''), cents, at }] : [];
          });
          if (credits.length > 0 && ledgerPays.length === payments.length) {
            ledger = buildPaymentLedger(credits, ledgerPays);
            ledgerCredits = credits;
            console.log(`[bg/payment-ledger] user ${user.id}: ${credits.length} receipt credits, ${ledger.byPayment.size}/${payments.length} payments assigned, unassigned payments=${JSON.stringify(ledger.unassignedPayments.map(u => ({ id: u.id, cents: u.cents })))}, unassigned receipts=${ledger.unassignedReceipts.length}`);
          } else {
            console.warn(`[bg/payment-ledger] user ${user.id}: no usable activity (${credits.length} receipt credits, ${ledgerPays.length}/${payments.length} payments readable); using the heuristic`);
          }
        } catch (e) {
          console.warn(`[bg/payment-ledger] user ${user.id}: activities failed, using the heuristic:`, String(e).slice(0, 160));
        }

        // Use payments API to determine which receipts are truly paid out.
        // REQUESTED payments haven't been sent yet — sum their amounts to get
        // the "pending payout" total, then mark the newest receipts up to that
        // amount as creditedOnly (confirmed but not yet disbursed).
        const requestedCents = payments
          .filter(p => p.status === 'REQUESTED')
          .reduce((sum, p) => sum + Math.round(parseFloat(p.amount || '0') * 100), 0);

        // Diagnostic: payment status breakdown. If a status other than PAID/
        // REQUESTED/SENT shows up here (e.g. PROCESSING/IN_TRANSIT), the
        // requestedCents filter is missing it and receipts will read as Paid
        // before the money lands. See which statuses BG is actually returning.
        const statusCounts: Record<string, number> = {};
        for (const p of payments) statusCounts[p.status ?? '?'] = (statusCounts[p.status ?? '?'] ?? 0) + 1;
        console.log(`[bg/payment-reconcile] user ${user.id}: ${payments.length} payments, statuses=${JSON.stringify(statusCounts)}, requestedCents=${requestedCents}`);

        let accumulatedCents = 0;
        const creditedOnly = new Set<string>();
        const creditedDbg: Array<{ rid: string; order: string; cents: number }> = [];
        if (ledger) {
          // Held = covered by a REQUESTED or SENT payment (requested, not yet in the bank), plus credits after the last request (unrequested).
          const open = new Set(payments.filter(p => String(p.status ?? '').toUpperCase() !== 'PAID').map(p => String(p.payment_id ?? p.key ?? '')));
          for (const [pid, rids] of ledger.byPayment) if (open.has(pid)) for (const r of rids) creditedOnly.add(r);
          for (const u of ledger.unassignedPayments) if (open.has(u.id)) for (const r of u.windowReceipts) creditedOnly.add(r);
          for (const r of ledger.afterLastPayment) creditedOnly.add(r);
          // attributeReceipts compares BG's own receipt_id strings: add each held receipt's id as the receipts list spells it.
          const heldKeys = new Set(creditedOnly);
          for (const r of allReceipts) {
            const rid = String((r as Record<string, unknown>).receipt_id ?? '');
            if (heldKeys.has(bgRefKey(rid))) creditedOnly.add(rid);
          }
          console.log(`[bg/payment-reconcile] user ${user.id}: ledger holds ${heldKeys.size} receipts as creditedOnly`);
        } else {
          const paidSorted = allReceipts
            .filter((r) => (r as Record<string, unknown>).paid === true)
            .sort((a, b) => {
              const aDate = new Date(String((a as Record<string, unknown>).modified_dt ?? (a as Record<string, unknown>).created_dt ?? 0)).getTime();
              const bDate = new Date(String((b as Record<string, unknown>).modified_dt ?? (b as Record<string, unknown>).created_dt ?? 0)).getTime();
              return bDate - aDate;
            });
          for (const r of paidSorted) {
            if (accumulatedCents >= requestedCents) break;
            const rr = r as Record<string, unknown>;
            const rid = String(rr.receipt_id ?? '');
            const amt = parseFloat(String(rr.total_paid ?? rr.total ?? 0)) || 0;
            const amtCents = Math.round(amt * 100);
            if (accumulatedCents + amtCents <= requestedCents + 1) {
              creditedOnly.add(rid);
              accumulatedCents += amtCents;
              creditedDbg.push({ rid, order: String(rr.order_number ?? ''), cents: amtCents });
            } else {
              break;
            }
          }
          // Diagnostic: which receipts the heuristic held back as "requested, not
          // yet disbursed". If an order shows Paid in the tracker but "processed"
          // on BG's portal, check whether its receipt appears here — if not, either
          // requestedCents undercounted (missing payments) or the newest-first
          // amount-matching picked the wrong receipts.
          console.log(`[bg/payment-reconcile] user ${user.id}: held ${creditedOnly.size} receipts as creditedOnly (accumulated ${accumulatedCents}/${requestedCents} cents): ${JSON.stringify(creditedDbg)}`);
        }

        // Fetch BG orders (includes processing/shipped not yet in receipts) to sync tracking numbers back
        // Fetch BG orders to get set of tracking numbers already submitted to BG
        const bgSubmittedTrackings = new Set<string>();
        for (const raw of (await getAllOrders(token)) as unknown[]) {
          const o = raw as Record<string, unknown>;
          const nestedTracking = o.tracking as Record<string, unknown> | null | undefined;
          const tid = normalize(String(nestedTracking?.tracking_id ?? o.tracking_id ?? ''));
          if (tid) bgSubmittedTrackings.add(tid);
        }

        const orders = await prisma.order.findMany({
          where: { userId: user.id },
          select: { id: true, orderNumber: true, salePrice: true, salePriceSynced: true, bgExpectedPayout: true, bgPaidAmount: true, bgPaidAt: true, bgPayoutDay: true, trackingNumbers: true, trackingSubmittedToBg: true, overdueAt: true, lost: true, bgCredited: true, buyerMismatch: true, locked: true, userEditedFields: true, buyer: { select: { name: true } } },
        });
        // Orders whose expectation comes from a BG commitment link (recalcSalePrice).
        const commitmentLinked = new Set(
          (await prisma.orderCommitmentLink.findMany({ where: { orderId: { in: orders.map(o => o.id) } }, select: { orderId: true }, distinct: ['orderId'] })).map(l => l.orderId),
        );

        // Mark orders as submitted to BG if their tracking number is in BG orders list
        for (const order of orders) {
          if (order.trackingSubmittedToBg) continue;
          if (!order.trackingNumbers) continue;
          const submitted = order.trackingNumbers.split(',').map(s => normalize(s.trim())).some(t => t && bgSubmittedTrackings.has(t));
          if (submitted) {
            await prisma.order.update({ where: { id: order.id }, data: { trackingSubmittedToBg: true } });
            order.trackingSubmittedToBg = true;
          }
        }

        const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        let updated = 0;

        const { paidAmountByOrder, paidAtByOrder, payoutDayByOrder, inBalanceAmountByOrder, creditedTrackingsByOrder, bgMatchedOrderIds, receiptOverdueIds } = attributeReceipts(orders, allReceipts, { creditedOnly, syncStartDate, cutoff });

        // Keep each PAID payment BG listed (id, amount, day) for the Books bank matcher. With the ledger a payment carries its orders: each
        // receipt it covers is attributed to a tracker order (the same attribution as above), the cents per order being the receipt's
        // activity amount (its total plus the 5 cent tracking reward). A payment with a receipt that maps to no tracker order, or none
        // known, is kept as a total only. The buyer is the one most of the orders belong to. A failure never fails the sync.
        const ledgerPayoutDay = new Map<number, string>(); // order id -> earliest day a ledger-assigned PAID payment paid one of its receipts
        try {
          const paidIds = [...paidAmountByOrder.keys()];
          const buyerRows = paidIds.length ? await prisma.order.findMany({ where: { id: { in: paidIds }, userId: user.id }, select: { buyerId: true } }) : [];
          const payBuyer = commonBuyerId(buyerRows.map(b => b.buyerId));
          const receiptByKey = new Map<string, unknown>(allReceipts.map(r => [bgRefKey((r as Record<string, unknown>).receipt_id), r]));
          const creditCents = new Map(ledgerCredits.map(c => [c.receiptId, c.cents]));
          for (const p of payments) {
            if (String(p.status ?? '').toUpperCase() !== 'PAID') continue;
            const ref = String(p.payment_id ?? p.key ?? '');
            const day = dayOf(p.paid_dt) ?? dayOf(p.processed_dt);
            const amount = parseFloat(p.amount || '0');
            const rids = ledger?.byPayment.get(ref);
            const byOrder = rids ? orderCentsOfReceipts(rids, receiptByKey, creditCents, orders) : null;
            if (byOrder && day) {
              await recordGroupPayment(user.id, 'bg', ref, amount, day, new Map([...byOrder].map(([id, c]) => [id, c / 100])));
              for (const id of byOrder.keys()) { const prev = ledgerPayoutDay.get(id); if (!prev || day < prev) ledgerPayoutDay.set(id, day); }
            } else {
              if (rids) console.log(`[bg/payment-ledger] user ${user.id}: payment ${ref} kept as a total: some of its receipts map to no tracker order`);
              await recordGroupPaymentTotal(user.id, 'bg', ref, amount, day, payBuyer);
            }
          }
        } catch (e) {
          console.warn(`[BG sync] user ${user.id}: storing payments failed:`, String(e).slice(0, 160));
        }

        // Now update orders based on accumulated paid amounts
        for (const order of orders) {
          if (order.lost) continue;
          // inBalance covers paid + verified (ACH pending) — used for bgPaidAmount/mismatch
          const inBalanceAmount = inBalanceAmountByOrder.get(order.id) ?? null;
          const trulyPaidAmount = paidAmountByOrder.get(order.id) ?? null;
          const updateData: Record<string, unknown> = {};
          const buyerName = (order.buyer as { name?: string } | null)?.name ?? '';
          const isBfmrBuyer = /bfmr/i.test(buyerName);

          // No commitment link -> BG's credited receipt total is the expectation
          // (replaces a stale BFMR reservation figure, order 952).
          if (!isBfmrBuyer) {
            const fullyCredited = order.bgCredited || (!!order.trackingNumbers && isOrderFullyCredited(
              [...new Set(order.trackingNumbers.split(',').map(s => normalize(s.trim())).filter(Boolean))],
              creditedTrackingsByOrder.get(order.id) ?? new Set<string>(),
            ));
            const adopted = bgReceiptExpectedPayout({
              bgExpectedPayout: order.bgExpectedPayout,
              locked: !!order.locked,
              userEditedExpected: parseUserEditedFields(order.userEditedFields).includes('bgExpectedPayout'),
              hasCommitmentLinks: commitmentLinked.has(order.id),
              fullyCredited,
              inBalanceAmount,
            });
            if (adopted !== undefined) {
              updateData.bgExpectedPayout = adopted;
              order.bgExpectedPayout = adopted;
            }
          }
          const expectedPayout = order.bgExpectedPayout ?? order.salePrice;
          const isFullyPaid = trulyPaidAmount != null && expectedPayout != null && trulyPaidAmount >= expectedPayout - 0.01;
          const isFullyInBalance = inBalanceAmount != null && expectedPayout != null && inBalanceAmount >= expectedPayout - 0.01;

          // Flag mismatch if BG has a receipt for a BFMR-assigned order (or vice versa)
          if (bgMatchedOrderIds.has(order.id)) {
            if (isBfmrBuyer && !order.buyerMismatch) updateData.buyerMismatch = true;
            if (!isBfmrBuyer && order.buyerMismatch) updateData.buyerMismatch = false;
          }

          // FMRB sync owns financial fields for BFMR orders — skip them here to avoid conflicts
          if (!isBfmrBuyer) {
            // bgPaidAmount must reflect money actually disbursed, not merely
            // credited-to-balance — see app/buyinggroup/page.tsx's isTrulyPaid().
            if (trulyPaidAmount != null && (force || Math.abs((order.bgPaidAmount ?? -1) - trulyPaidAmount) > 0.01)) {
              updateData.bgPaidAmount = trulyPaidAmount;
            }
            // BG-credited only when EVERY shipment of this order has an
            // in-balance receipt — one credited package on a multi-package
            // order is not enough (the 899 bug).
            if (!order.bgCredited && order.trackingNumbers) {
              const orderTrackings = [...new Set(
                order.trackingNumbers.split(',').map(s => normalize(s.trim())).filter(Boolean),
              )];
              if (isOrderFullyCredited(orderTrackings, creditedTrackingsByOrder.get(order.id) ?? new Set<string>())) {
                updateData.bgCredited = true;
              }
            }
            if (isFullyPaid && (force || !order.salePriceSynced)) {
              console.log(`[bg/payment-reconcile] user ${user.id}: marking order ${order.orderNumber} PAID (trulyPaid=${trulyPaidAmount?.toFixed(2)} >= expected=${expectedPayout?.toFixed(2)})`);
              updateData.salePriceSynced = true;
              updateData.locked = true;
              if (order.salePrice == null || force) updateData.salePrice = order.bgExpectedPayout ?? trulyPaidAmount;
            }
            if ((isFullyPaid || isFullyInBalance) && order.overdueAt) updateData.overdueAt = null;
            if (!isFullyInBalance && !order.salePriceSynced && receiptOverdueIds.has(order.id) && !order.overdueAt) updateData.overdueAt = new Date();
          }

          if (!Object.keys(updateData).length) continue;
          // Skip locked orders entirely — locking is the user's "freeze
          // this order" signal. We do still allow the update through
          // when the same call is the one *setting* locked=true (the
          // updateMany evaluates locked=false at the moment of write,
          // so the atomic transition to locked still goes through).
          const { count } = await prisma.order.updateMany({ where: { id: order.id, locked: false }, data: updateData });
          if (count > 0) { totalUpdated++; updated++; }
        }

        // The day BG credited each order, for the Books deposit matcher. Written even on locked orders (a paid order is
        // locked by the loop above) and never for BFMR-assigned ones; it is derived from receipts, not a user field.
        for (const order of orders) {
          const at = paidAtByOrder.get(order.id);
          if (!at || /bfmr/i.test((order.buyer as { name?: string } | null)?.name ?? '')) continue;
          if (order.bgPaidAt && order.bgPaidAt.getTime() === at.getTime()) continue;
          await prisma.order.update({ where: { id: order.id }, data: { bgPaidAt: at } });
        }

        // The day BG paid out each order's receipt (modified_dt), for matching its deposit. Set once, the first time a receipt is seen paid,
        // and never overwritten: modified_dt changes later.
        // The ledger knows the day each payment was paid, which is exact; it replaces the receipt-derived day.
        for (const order of orders) {
          const day = ledgerPayoutDay.get(order.id);
          if (!day || order.bgPayoutDay === day || /bfmr/i.test((order.buyer as { name?: string } | null)?.name ?? '')) continue;
          await prisma.order.update({ where: { id: order.id }, data: { bgPayoutDay: day } });
          order.bgPayoutDay = day;
        }
        for (const order of orders) {
          const day = payoutDayByOrder.get(order.id);
          if (!day || order.bgPayoutDay || /bfmr/i.test((order.buyer as { name?: string } | null)?.name ?? '')) continue;
          await prisma.order.updateMany({ where: { id: order.id, bgPayoutDay: null }, data: { bgPayoutDay: day } });
        }

        // Also flag orders with no BG receipt at all but old enough (skip BFMR — their sync owns overdueAt)
        const overdueOrders = orders.filter(o => {
          const bName = (o.buyer as { name?: string } | null)?.name ?? '';
          return o.salePrice == null && !o.salePriceSynced && !paidAmountByOrder.has(o.id) && !receiptOverdueIds.has(o.id) && !o.overdueAt && !/bfmr/i.test(bName) && !isCardCenterBuyer(bName);
        });
        if (overdueOrders.length > 0) {
          const fullOrders = await prisma.order.findMany({
            where: { id: { in: overdueOrders.map(o => o.id) }, platform: { in: ['Walmart', 'Amazon'] }, orderDate: { lt: cutoff } },
            select: { id: true },
          });
          for (const o of fullOrders) {
            await prisma.order.updateMany({ where: { id: o.id, locked: false }, data: { overdueAt: new Date() } });
          }
          if (fullOrders.length > 0) console.log(`[BG sync] user ${user.id}: flagged ${fullOrders.length} overdue orders`);
        }

        if (updated > 0) console.log(`[BG sync] user ${user.id}: updated ${updated} orders`);
        // Returns page tasks: its own try so a returns problem never fails the receipt sync.
        await syncBgReturns(user.id).catch(e => console.warn(`[BG sync] user ${user.id} returns sync failed:`, String(e).slice(0, 160)));
        synced++;
      } catch (e) {
        failed++;
        failedUserIds.push(user.id);
        console.error(`[BG sync] user ${user.id} failed:`, e);
        void logApiError({
          userId: user.id,
          group: 'BG',
          endpoint: 'runBgReceiptSync',
          context: 'per-user sync failed',
          body: String(e).slice(0, 500),
        });
      }
    }
  } catch (e) {
    failed++;
    console.error('[BG sync] fatal:', e);
    void logApiError({
      userId: null,
      group: 'BG',
      endpoint: 'runBgReceiptSync',
      context: 'fatal sync error',
      body: String(e).slice(0, 500),
    });
  }
  return { updated: totalUpdated, reset: totalReset, failed, synced, failedUserIds };
}
