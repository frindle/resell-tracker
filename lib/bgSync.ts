import { prisma } from '@/lib/db';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getReceipts, getOrders, getPayments } from '@/lib/buyinggroup';

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

        const syncStartSetting = await prisma.setting.findFirst({ where: { userId: user.id, key: 'bg_sync_start_date' } });
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

        const paidSorted = allReceipts
          .filter((r) => (r as Record<string, unknown>).paid === true)
          .sort((a, b) => {
            const aDate = new Date(String((a as Record<string, unknown>).modified_dt ?? (a as Record<string, unknown>).created_dt ?? 0)).getTime();
            const bDate = new Date(String((b as Record<string, unknown>).modified_dt ?? (b as Record<string, unknown>).created_dt ?? 0)).getTime();
            return bDate - aDate;
          });
        let accumulatedCents = 0;
        const creditedOnly = new Set<string>();
        for (const r of paidSorted) {
          if (accumulatedCents >= requestedCents) break;
          const rid = String((r as Record<string, unknown>).receipt_id ?? '');
          const amt = parseFloat(String((r as Record<string, unknown>).total_paid ?? (r as Record<string, unknown>).total ?? 0)) || 0;
          const amtCents = Math.round(amt * 100);
          if (accumulatedCents + amtCents <= requestedCents + 1) {
            creditedOnly.add(rid);
            accumulatedCents += amtCents;
          } else {
            break;
          }
        }

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
              const tid = normalize(String(o.tracking_id ?? ''));
              if (tid) bgSubmittedTrackings.add(tid);
            }
            if (items.length < 50) break;
            p++;
          }
        }

        const orders = await prisma.order.findMany({
          where: { userId: user.id },
          select: { id: true, orderNumber: true, salePrice: true, salePriceSynced: true, bgExpectedPayout: true, bgPaidAmount: true, trackingNumbers: true, trackingSubmittedToBg: true, overdueAt: true, lost: true },
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

        // Build lookup maps by order number and by tracking number
        const byOrderNumber = new Map<string, typeof orders[0]>();
        const byTracking = new Map<string, typeof orders[0]>();
        for (const o of orders) {
          const norm = normalize(o.orderNumber);
          if (norm) byOrderNumber.set(norm, o);
          if (!o.trackingNumbers) continue;
          for (const t of o.trackingNumbers.split(',').map(s => s.trim()).filter(Boolean)) {
            byTracking.set(normalize(t), o);
          }
        }

        const receiptOverdueIds = new Set<number>();
        // Accumulate paid receipt totals per order across all receipts
        const paidAmountByOrder = new Map<number, number>();
        const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        let updated = 0;

        for (const raw of allReceipts) {
          const r = raw as Record<string, unknown>;

          // Skip receipts before sync start date
          if (syncStartDate) {
            const createdRaw = String(r.created_dt ?? '');
            const createdAt = createdRaw ? new Date(createdRaw) : null;
            if (createdAt && createdAt < syncStartDate) continue;
          }

          // Prefer matching by order number to avoid same-amount orders cross-contaminating
          const receiptOrderNum = normalize(String(r.order_number ?? ''));
          const trackingObj = r.tracking as Record<string, unknown> | null | undefined;
          const trackingId = normalize(String(trackingObj?.tracking_id ?? ''));

          const match = (receiptOrderNum ? byOrderNumber.get(receiptOrderNum) : null)
            ?? (trackingId ? byTracking.get(trackingId) : null);
          if (!match) continue;

          const isPaid = r.paid === true && !creditedOnly.has(String(r.receipt_id ?? ''));
          const receiptTotal = parseFloat(String(r.total ?? 0)) || 0;

          if (isPaid) {
            paidAmountByOrder.set(match.id, (paidAmountByOrder.get(match.id) ?? 0) + receiptTotal);
          } else {
            const createdRaw = String(r.created_dt ?? '');
            const createdAt = createdRaw ? new Date(createdRaw) : null;
            if (createdAt && createdAt < cutoff) receiptOverdueIds.add(match.id);
          }
        }

        // Now update orders based on accumulated paid amounts
        for (const order of orders) {
          if (order.lost) continue;
          const paidAmount = paidAmountByOrder.get(order.id) ?? null;
          const expectedPayout = order.bgExpectedPayout ?? order.salePrice;
          const isFullyPaid = paidAmount != null && expectedPayout != null && paidAmount >= expectedPayout - 0.01;

          const updateData: Record<string, unknown> = {};

          if (paidAmount != null && (force || paidAmount !== order.bgPaidAmount)) {
            updateData.bgPaidAmount = paidAmount;
          }
          if (isFullyPaid && (force || !order.salePriceSynced)) {
            updateData.salePriceSynced = true;
            // For split orders use bgExpectedPayout as the sale price, not the combined receipt total
            if (order.salePrice == null || force) updateData.salePrice = order.bgExpectedPayout ?? paidAmount;
          }
          if (isFullyPaid && order.overdueAt) updateData.overdueAt = null;
          if (!isFullyPaid && !order.salePriceSynced && receiptOverdueIds.has(order.id) && !order.overdueAt) updateData.overdueAt = new Date();

          if (!Object.keys(updateData).length) continue;
          await prisma.order.update({ where: { id: order.id }, data: updateData });
          if (updateData.salePriceSynced === false) totalReset++; else totalUpdated++;
          updated++;
        }

        // Also flag orders with no BG receipt at all but old enough
        const overdueOrders = orders.filter(o =>
          !o.salePrice &&
          !o.salePriceSynced &&
          !paidAmountByOrder.has(o.id) &&
          !receiptOverdueIds.has(o.id) &&
          !o.overdueAt
        );
        if (overdueOrders.length > 0) {
          const fullOrders = await prisma.order.findMany({
            where: { id: { in: overdueOrders.map(o => o.id) }, platform: { in: ['Walmart', 'Amazon'] }, orderDate: { lt: cutoff } },
            select: { id: true },
          });
          for (const o of fullOrders) {
            await prisma.order.update({ where: { id: o.id }, data: { overdueAt: new Date() } });
          }
          if (fullOrders.length > 0) console.log(`[BG sync] user ${user.id}: flagged ${fullOrders.length} overdue orders`);
        }

        if (updated > 0) console.log(`[BG sync] user ${user.id}: updated ${updated} orders`);
      } catch (e) {
        console.error(`[BG sync] user ${user.id} failed:`, e);
      }
    }
  } catch (e) {
    console.error('[BG sync] fatal:', e);
  }
  return { updated: totalUpdated, reset: totalReset };
}
