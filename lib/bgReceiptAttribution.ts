export function normalizeDigits(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export function isCardCenterBuyer(buyerName: string | null | undefined): boolean {
  const name = buyerName ?? '';
  return /card\s*center/i.test(name);
}

export type AttributionOrder = {
  id: number;
  orderNumber: string | null;
  salePrice: number | null;
  bgExpectedPayout: number | null;
  trackingNumbers: string | null;
  buyer: { name?: string | null } | null;
};

export function attributeReceipts(
  orders: AttributionOrder[],
  receipts: unknown[],
  opts: { creditedOnly: Set<string>; syncStartDate: Date | null; cutoff: Date },
): {
  paidAmountByOrder: Map<number, number>;
  inBalanceAmountByOrder: Map<number, number>;
  creditedTrackingsByOrder: Map<number, Set<string>>;
  bgMatchedOrderIds: Set<number>;
  receiptOverdueIds: Set<number>;
} {
  const filteredOrders = orders.filter(o => !isCardCenterBuyer(o.buyer?.name));

  const byOrderNumber = new Map<string, typeof filteredOrders[0]>();
  const byOrderNumberTruncated = new Map<string, typeof filteredOrders[0]>();
  const trackingToOrders = new Map<string, Array<typeof filteredOrders[0]>>();
  for (const o of filteredOrders) {
    const norm = normalizeDigits(o.orderNumber);
    if (norm) {
      byOrderNumber.set(norm, o);
      if (norm.length >= 8) {
        const truncated = norm.slice(0, -1);
        if (!byOrderNumber.has(truncated)) {
          if (byOrderNumberTruncated.has(truncated)) {
            byOrderNumberTruncated.delete(truncated);
          } else {
            byOrderNumberTruncated.set(truncated, o);
          }
        }
      }
    }
    if (!o.trackingNumbers) continue;
    for (const t of o.trackingNumbers.split(',').map(s => normalizeDigits(s.trim())).filter(Boolean)) {
      if (!trackingToOrders.has(t)) trackingToOrders.set(t, []);
      trackingToOrders.get(t)!.push(o);
    }
  }

  const receiptOverdueIds = new Set<number>();
  const creditedTrackingsByOrder = new Map<number, Set<string>>();
  const creditTrackingForOrder = (orderId: number, token: string | null | undefined): void => {
    if (!token) return;
    let tokens = creditedTrackingsByOrder.get(orderId);
    if (!tokens) {
      tokens = new Set<string>();
      creditedTrackingsByOrder.set(orderId, tokens);
    }
    tokens.add(token);
  };
  const bgMatchedOrderIds = new Set<number>();
  const paidAmountByOrder = new Map<number, number>();
  const inBalanceAmountByOrder = new Map<number, number>();
  const { cutoff } = opts;
  // Receipts on a tracking several orders share, split in a second pass once
  // every single-owner receipt is counted (see below).
  const shared: { sharedOrders: typeof filteredOrders; trackingId: string; isInBalance: boolean; isPaid: boolean; isReturn: boolean; receiptTotal: number; createdAt: Date | null }[] = [];

  for (const raw of receipts) {
    const r = raw as Record<string, unknown>;

    if (opts.syncStartDate) {
      const createdRaw = String(r.created_dt ?? '');
      const createdAt = createdRaw ? new Date(createdRaw) : null;
      if (createdAt && createdAt < opts.syncStartDate) continue;
    }

    const receiptOrderNum = normalizeDigits(String(r.order_number ?? ''));
    const trackingObj = r.tracking as Record<string, unknown> | null | undefined;
    const trackingId = normalizeDigits(String(trackingObj?.tracking_id ?? ''));

    const receiptStatus = String(r.status ?? '').toLowerCase();
    const isReturn = /^(return|returned|refund|refunded)$/.test(receiptStatus);
    const isInBalance = !isReturn && (r.paid === true || receiptStatus === 'verified');
    const isPaid = !isReturn && r.paid === true && !opts.creditedOnly.has(String(r.receipt_id ?? ''));
    const receiptTotal = parseFloat(String(r.total ?? 0)) || 0;
    const createdRaw = String(r.created_dt ?? '');
    const createdAt = createdRaw ? new Date(createdRaw) : null;

    let orderNumMatch = receiptOrderNum ? byOrderNumber.get(receiptOrderNum) : null;
    if (!orderNumMatch && receiptOrderNum) {
      const fuzzy = byOrderNumberTruncated.get(receiptOrderNum);
      if (fuzzy) {
        console.log(`[bg/payment-reconcile] fuzzy match: portal="${receiptOrderNum}" ↔ order="${normalizeDigits(fuzzy.orderNumber)}" (dropped trailing digit)`);
        orderNumMatch = fuzzy;
      }
    }
    if (orderNumMatch) {
      bgMatchedOrderIds.add(orderNumMatch.id);
      if (isInBalance) creditTrackingForOrder(orderNumMatch.id, trackingId || null);
      if (isInBalance) inBalanceAmountByOrder.set(orderNumMatch.id, (inBalanceAmountByOrder.get(orderNumMatch.id) ?? 0) + receiptTotal);
      if (isPaid) paidAmountByOrder.set(orderNumMatch.id, (paidAmountByOrder.get(orderNumMatch.id) ?? 0) + receiptTotal);
      if (!isReturn && !isInBalance && createdAt && createdAt < cutoff) receiptOverdueIds.add(orderNumMatch.id);
      continue;
    }

    if (!trackingId) continue;
    const sharedOrders = trackingToOrders.get(trackingId) ?? [];
    if (sharedOrders.length === 0) continue;

    if (sharedOrders.length === 1) {
      const match = sharedOrders[0];
      bgMatchedOrderIds.add(match.id);
      if (isInBalance) creditTrackingForOrder(match.id, trackingId || null);
      if (isInBalance) inBalanceAmountByOrder.set(match.id, (inBalanceAmountByOrder.get(match.id) ?? 0) + receiptTotal);
      if (isPaid) paidAmountByOrder.set(match.id, (paidAmountByOrder.get(match.id) ?? 0) + receiptTotal);
      if (!isReturn && !isInBalance && createdAt && createdAt < cutoff) receiptOverdueIds.add(match.id);
    } else {
      shared.push({ sharedOrders, trackingId, isInBalance, isPaid, isReturn, receiptTotal, createdAt });
    }
  }

  // Shared boxes are split by what each order still has OUTSTANDING after its
  // single-owner receipts, not by its whole expectation, and an order for which
  // a box is the LAST one it could still be paid from claims its outstanding
  // amount from that box first. Order 665 (3 units, $1197): 2 units in its own
  // box ($798), 1 in a box shared with order 694 ($180); splitting the $579
  // receipt on whole expectations gave 665 $503 instead of $399. Orders
  // 154/155/156: 154 had one unit in each of 155's and 156's boxes, which only
  // resolves when 155 and 156 (single box each) claim first. Whatever is left
  // over goes by outstanding, then by whole expectation, then evenly.
  const weightOf = (o: typeof filteredOrders[number]) => o.bgExpectedPayout ?? o.salePrice ?? 0;
  const counted = new Map(inBalanceAmountByOrder);
  const outstandingOf = (o: typeof filteredOrders[number]) => Math.max(0, weightOf(o) - (counted.get(o.id) ?? 0));
  const spread = (orders: typeof filteredOrders, amount: number, weight: (o: typeof filteredOrders[number]) => number) => {
    const total = orders.reduce((sum, o) => sum + weight(o), 0);
    return total > 0 ? orders.map(o => amount * (weight(o) / total)) : null;
  };
  const pending = [...shared];
  while (pending.length > 0) {
    const pendingCount = (id: number) => pending.filter(p => p.sharedOrders.some(o => o.id === id)).length;
    const pick = Math.max(0, pending.findIndex(p => p.sharedOrders.some(o => pendingCount(o.id) === 1)));
    const { sharedOrders, trackingId, isInBalance, isPaid, isReturn, receiptTotal, createdAt } = pending.splice(pick, 1)[0];
    const lastBox = new Set(sharedOrders.filter(o => pendingCount(o.id) === 0).map(o => o.id));
    const shares = new Map<number, number>(sharedOrders.map(o => [o.id, 0]));
    const claimers = sharedOrders.filter(o => lastBox.has(o.id));
    let left = receiptTotal;
    const claimOwed = claimers.reduce((sum, o) => sum + outstandingOf(o), 0);
    if (claimOwed > 0) {
      const take = Math.min(left, claimOwed);
      spread(claimers, take, outstandingOf)!.forEach((v, i) => shares.set(claimers[i].id, v));
      left -= take;
    }
    if (left > 0.005) {
      const rest = sharedOrders.filter(o => !lastBox.has(o.id) || claimOwed === 0);
      const pool = rest.length > 0 ? rest : sharedOrders;
      const by = spread(pool, left, outstandingOf) ?? spread(pool, left, weightOf) ?? pool.map(() => left / pool.length);
      by.forEach((v, i) => shares.set(pool[i].id, (shares.get(pool[i].id) ?? 0) + v));
    }
    for (const o of sharedOrders) {
      const share = shares.get(o.id) ?? 0;
      bgMatchedOrderIds.add(o.id);
      if (isInBalance) creditTrackingForOrder(o.id, trackingId || null);
      if (isInBalance) inBalanceAmountByOrder.set(o.id, (inBalanceAmountByOrder.get(o.id) ?? 0) + share);
      if (isPaid) paidAmountByOrder.set(o.id, (paidAmountByOrder.get(o.id) ?? 0) + share);
      if (!isReturn && !isInBalance && createdAt && createdAt < cutoff) receiptOverdueIds.add(o.id);
      if (isInBalance) counted.set(o.id, inBalanceAmountByOrder.get(o.id) ?? 0);
    }
  }

  return {
    paidAmountByOrder,
    inBalanceAmountByOrder,
    creditedTrackingsByOrder,
    bgMatchedOrderIds,
    receiptOverdueIds,
  };
}
