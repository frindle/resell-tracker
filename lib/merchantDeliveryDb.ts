import { prisma } from '@/lib/db';
import { withKeyedLock } from '@/lib/keyedLock';
import { detectCarrier } from '@/lib/carrierDetect';
import { decideMerchantDelivery, earlierShipDate, merchantSourceFor, merchantDeliveredAt } from '@/lib/merchantDelivery';

// Database side of lib/merchantDelivery.ts. One place writes Amazon / Walmart delivered dates and email ship
// dates into CarrierDelivery. Nothing here logs a tracking number.

const key = (s: string) => String(s ?? '').trim().replace(/\s+/g, '').toUpperCase();
const locked = <T>(uid: number, work: () => Promise<T>) => withKeyedLock(`carrier_delivery:${uid}`, work);

export type DeliveredNumber = { trackingNumber: string; carrierName?: string | null };

/**
 * Records that Amazon or Walmart delivered these numbers of one order at `deliveredAt`. Numbers that belong to a
 * carrier's own page (FedEx, UPS) are left alone. Returns how many rows were written.
 */
export async function recordMerchantDelivery(
  userId: number,
  order: { platform?: string | null; orderNumber?: string | null },
  numbers: readonly DeliveredNumber[],
  deliveredAt: Date,
  now: Date = new Date(),
  orderDate: Date | null = null,
): Promise<number> {
  return locked(userId, async () => {
    let written = 0;
    const done = new Set<string>();
    for (const n of numbers) {
      const trackingNumber = key(n.trackingNumber);
      if (!trackingNumber || trackingNumber.length > 40 || done.has(trackingNumber)) continue;
      done.add(trackingNumber);
      const source = merchantSourceFor(order, trackingNumber, n.carrierName);
      if (!source) continue;
      const where = { userId_trackingNumber: { userId, trackingNumber } };
      const existing = await prisma.carrierDelivery.findUnique({ where, select: { source: true, deliveredAt: true } });
      const decision = decideMerchantDelivery(existing, deliveredAt, now, orderDate);
      if (decision.action === 'skip') continue;
      const data = { carrier: source, status: 'delivered', source, deliveredAt: decision.deliveredAt };
      await prisma.carrierDelivery.upsert({ where, create: { userId, trackingNumber, attempts: 0, ...data }, update: data });
      written++;
    }
    return written;
  });
}

/** What one imported order row says about shipping and delivery (all optional; see ImportRow in app/api/import/route.ts). */
export type ImportShipSignals = {
  platform: string;
  orderNumber: string;
  /** The order's date (ISO text): a delivery cannot be dated before it. */
  orderDate?: string;
  /** Numbers on the row plus the ones the order already had. */
  trackingNumbers: readonly string[];
  deliveredText?: string;
  deliveredEmailAt?: string;
  trackingShippedAt?: Record<string, string>;
};

/** Writes the delivery and ship dates an imported row carries. Never throws: the import must not fail over this. */
export async function recordImportSignals(userId: number, rows: readonly ImportShipSignals[], now: Date = new Date()): Promise<void> {
  for (const r of rows) {
    try {
      const nums = r.trackingNumbers.map(key).filter(Boolean);
      if ((r.platform === 'Amazon' || r.platform === 'Walmart') && (r.deliveredText || r.deliveredEmailAt) && nums.length) {
        const od = r.orderDate ? new Date(r.orderDate) : null;
        const orderDate = od && Number.isFinite(od.getTime()) ? od : null;
        const at = merchantDeliveredAt({ pageText: r.deliveredText, emailDate: r.deliveredEmailAt, now, orderDate });
        if (at) await recordMerchantDelivery(userId, r, nums.map(trackingNumber => ({ trackingNumber })), at, now, orderDate);
      }
      for (const [num, iso] of Object.entries(r.trackingShippedAt ?? {})) {
        const when = new Date(iso);
        if (!Number.isNaN(when.getTime())) await recordShipDate(userId, num, when, now);
      }
    } catch (e) {
      console.error('[carrier-delivery] record failed:', String(e).slice(0, 160));
    }
  }
}

/**
 * Remembers when a shipping email said a FedEx or UPS number shipped (the earliest such date). The tracker's
 * 14-day checking window runs from it. Other carriers are not looked up, so they are not recorded.
 */
export async function recordShipDate(userId: number, trackingNumber: string, shippedAt: Date, now: Date = new Date()): Promise<boolean> {
  const tn = key(trackingNumber);
  const carrier = detectCarrier(tn);
  if (!tn || tn.length > 40 || (carrier !== 'fedex' && carrier !== 'ups')) return false;
  if (!Number.isFinite(shippedAt.getTime()) || shippedAt.getTime() > now.getTime() + 2 * 86_400_000) return false;
  return locked(userId, async () => {
    const where = { userId_trackingNumber: { userId, trackingNumber: tn } };
    const existing = await prisma.carrierDelivery.findUnique({ where, select: { shippedAt: true } });
    const best = earlierShipDate(existing?.shippedAt, shippedAt);
    if (existing?.shippedAt && best && best.getTime() === existing.shippedAt.getTime()) return false;
    await prisma.carrierDelivery.upsert({
      where,
      create: { userId, carrier, trackingNumber: tn, source: 'email', shippedAt: best },
      update: { shippedAt: best },
    });
    return true;
  });
}
