import { prisma, getSetting } from '@/lib/db';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getReceipts, getOrders, getPayments } from '@/lib/buyinggroup';
import { logApiError } from '@/lib/apiErrorLog';
import { isOrderFullyCredited } from '@/lib/bgCredited';
import { attributeReceipts, isCardCenterBuyer } from '@/lib/bgReceiptAttribution';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export async function runBgReceiptSync(force = false): Promise<{ updated: number; reset: number }> {
  let totalUpdated = 0;
  let totalReset = 0;
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

        const [payments, firstReceiptData] = await Promise.all([
          getPayments(token),
          getReceipts(token, 1, 50),
        ]);
        const allReceipts: unknown[] = [];
        const firstData = firstReceiptData as Record<string, unknown>;
        const firstPayload = firstData.payload as Record<string, unknown> | undefined;
        const firstItems = (Array.isArray(firstReceiptData) ? firstReceiptData : (firstPayload?.receipts ?? firstData.results ?? firstData.data ?? [])) as unknown[];
        allReceipts.push(...firstItems);
        let page = 2;
        while (firstItems.length >= 50) {
          const data = await getReceipts(token, page, 50);
          const d = data as Record<string, unknown>;
          const payload = d.payload as Record<string, unknown> | undefined;
          const items = (Array.isArray(data) ? data : (payload?.receipts ?? d.results ?? d.data ?? [])) as unknown[];
          if (!items.length) break;
          allReceipts.push(...items);
          if (items.length < 50) break;
          page++;
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

        const paidSorted = allReceipts
          .filter((r) => (r as Record<string, unknown>).paid === true)
          .sort((a, b) => {
            const aDate = new Date(String((a as Record<string, unknown>).modified_dt ?? (a as Record<string, unknown>).created_dt ?? 0)).getTime();
            const bDate = new Date(String((b as Record<string, unknown>).modified_dt ?? (b as Record<string, unknown>).created_dt ?? 0)).getTime();
            return bDate - aDate;
          });
        let accumulatedCents = 0;
        const creditedOnly = new Set<string>();
        const creditedDbg: Array<{ rid: string; order: string; cents: number }> = [];
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

        // Fetch BG orders (includes processing/shipped not yet in receipts) to sync tracking numbers back
        // Fetch BG orders to get set of tracking numbers already submitted to BG
        const bgSubmittedTrackings = new Set<string>();
        {
          let p = 1;
          while (true) {
            const data = await getOrders(token, p, 50);
            const d = data as Record<string, unknown>;
            const payload2 = d.payload as Record<string, unknown> | undefined;
            const items = (Array.isArray(data) ? data : ((payload2?.orders ?? d.results ?? d.data ?? []) as unknown[])) as unknown[];
            for (const raw of items) {
              const o = raw as Record<string, unknown>;
              const nestedTracking = o.tracking as Record<string, unknown> | null | undefined;
              const tid = normalize(String(nestedTracking?.tracking_id ?? o.tracking_id ?? ''));
              if (tid) bgSubmittedTrackings.add(tid);
            }
            if (items.length < 50) break;
            p++;
          }
        }

        const orders = await prisma.order.findMany({
          where: { userId: user.id },
          select: { id: true, orderNumber: true, salePrice: true, salePriceSynced: true, bgExpectedPayout: true, bgPaidAmount: true, trackingNumbers: true, trackingSubmittedToBg: true, overdueAt: true, lost: true, bgCredited: true, buyerMismatch: true, buyer: { select: { name: true } } },
        });

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

        const { paidAmountByOrder, inBalanceAmountByOrder, creditedTrackingsByOrder, bgMatchedOrderIds, receiptOverdueIds } = attributeReceipts(orders, allReceipts, { creditedOnly, syncStartDate, cutoff });

        // Now update orders based on accumulated paid amounts
        for (const order of orders) {
          if (order.lost) continue;
          // inBalance covers paid + verified (ACH pending) — used for bgPaidAmount/mismatch
          const inBalanceAmount = inBalanceAmountByOrder.get(order.id) ?? null;
          const trulyPaidAmount = paidAmountByOrder.get(order.id) ?? null;
          const expectedPayout = order.bgExpectedPayout ?? order.salePrice;
          const isFullyPaid = trulyPaidAmount != null && expectedPayout != null && trulyPaidAmount >= expectedPayout - 0.01;
          const isFullyInBalance = inBalanceAmount != null && expectedPayout != null && inBalanceAmount >= expectedPayout - 0.01;

          const updateData: Record<string, unknown> = {};
          const buyerName = (order.buyer as { name?: string } | null)?.name ?? '';
          const isBfmrBuyer = /bfmr/i.test(buyerName);

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
      } catch (e) {
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
    console.error('[BG sync] fatal:', e);
    void logApiError({
      userId: null,
      group: 'BG',
      endpoint: 'runBgReceiptSync',
      context: 'fatal sync error',
      body: String(e).slice(0, 500),
    });
  }
  return { updated: totalUpdated, reset: totalReset };
}
