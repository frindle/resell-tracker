import { prisma } from '@/lib/db';
import { withKeyedLock } from '@/lib/keyedLock';
import { decideExpected, parseExpectedDelivery, type ExpectedSource } from '@/lib/expectedDelivery';

// Database side of lib/expectedDelivery.ts: writes the merchant's expected delivery onto the Order. Every source
// (Amazon page, Walmart page, email, carrier page) goes through here, so "the most recently seen wins" and
// "never overwrite a newer sighting with an older one" are decided in one place. Never logs an order number.

const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');
const locked = <T>(uid: number, work: () => Promise<T>) => withKeyedLock(`expected_delivery:${uid}`, work);

export type ExpectedObservation = {
  /** The order's number as the source shows it (any dashes). Ignored when orderId is given. */
  orderNumber?: string;
  orderId?: number;
  start: Date;
  end: Date;
  source: ExpectedSource;
  /** When the source was SEEN: the page capture time, the email's date. */
  seenAt: Date;
};

/** Writes each observation to its order when it is the most recently seen. Returns how many orders changed. */
export async function recordExpectedDeliveries(userId: number, list: readonly ExpectedObservation[], now: Date = new Date()): Promise<number> {
  if (!list.length) return 0;
  return locked(userId, async () => {
    const wantedNumbers = [...new Set(list.map(o => o.orderNumber).filter((n): n is string => !!n))];
    const byDigits = new Map<string, { id: number }[]>();
    if (wantedNumbers.length) {
      const rows = await prisma.order.findMany({
        where: { userId, orderNumber: { in: wantedNumbers } },
        select: { id: true, orderNumber: true },
      });
      const exact = new Set(rows.map(r => r.orderNumber));
      // A number written another way (dashes, spacing) is found by its digits.
      const rest = wantedNumbers.filter(n => !exact.has(n));
      const all = rest.length ? await prisma.order.findMany({ where: { userId, orderNumber: { not: null } }, select: { id: true, orderNumber: true } }) : rows;
      for (const r of all) {
        const k = digits(r.orderNumber);
        const cur = byDigits.get(k) ?? [];
        if (!cur.some(c => c.id === r.id)) byDigits.set(k, [...cur, { id: r.id }]);
      }
    }
    let changed = 0;
    for (const o of list) {
      try {
        const ids = o.orderId != null ? [o.orderId] : (byDigits.get(digits(o.orderNumber)) ?? []).map(x => x.id);
        for (const id of ids) {
          const existing = await prisma.order.findFirst({
            where: { id, userId },
            select: { cancelled: true, expectedDeliveryStart: true, expectedDeliveryEnd: true, expectedDeliverySource: true, expectedDeliverySeenAt: true },
          });
          if (!existing || existing.cancelled) continue;
          const decision = decideExpected({
            start: existing.expectedDeliveryStart, end: existing.expectedDeliveryEnd,
            source: existing.expectedDeliverySource, seenAt: existing.expectedDeliverySeenAt,
          }, o, now);
          if (decision === 'skip') continue;
          await prisma.order.update({
            where: { id },
            data: { expectedDeliveryStart: o.start, expectedDeliveryEnd: o.end, expectedDeliverySource: o.source, expectedDeliverySeenAt: o.seenAt },
          });
          changed++;
        }
      } catch (e) {
        console.error('[expected-delivery] record failed:', String(e).slice(0, 160));
      }
    }
    return changed;
  });
}

/**
 * Text a source showed for some orders ("Arriving tomorrow"), read relative to when it was seen and recorded.
 * Never throws: it must not fail a capture or an import.
 */
export async function recordExpectedFromText(
  userId: number,
  source: ExpectedSource,
  items: readonly { orderNumber?: string; orderId?: number; text: string | null | undefined }[],
  seenAt: Date,
  now: Date = new Date(),
): Promise<number> {
  try {
    const list: ExpectedObservation[] = [];
    for (const it of items) {
      const r = it.text ? parseExpectedDelivery(it.text, seenAt) : null;
      if (r) list.push({ orderNumber: it.orderNumber, orderId: it.orderId, start: r.start, end: r.end, source, seenAt });
    }
    return await recordExpectedDeliveries(userId, list, now);
  } catch (e) {
    console.error('[expected-delivery] failed:', String(e).slice(0, 160));
    return 0;
  }
}

/**
 * A carrier page said "Estimated delivery ...": the orders carrying that tracking number get it. Only called for
 * a package the page does not show delivered.
 */
export async function recordExpectedForTracking(userId: number, trackingNumber: string, text: string, seenAt: Date): Promise<number> {
  try {
    const r = parseExpectedDelivery(text, seenAt);
    if (!r || trackingNumber.length < 6) return 0;
    const orders = await prisma.order.findMany({ where: { userId, trackingNumbers: { contains: trackingNumber } }, select: { id: true, trackingNumbers: true } });
    const key = (s: string) => s.trim().replace(/\s+/g, '').toUpperCase();
    const mine = orders.filter(o => String(o.trackingNumbers ?? '').split(',').some(t => key(t) === key(trackingNumber)));
    return await recordExpectedDeliveries(userId, mine.map(o => ({ orderId: o.id, start: r.start, end: r.end, source: 'carrier' as const, seenAt })));
  } catch (e) {
    console.error('[expected-delivery] carrier failed:', String(e).slice(0, 160));
    return 0;
  }
}
