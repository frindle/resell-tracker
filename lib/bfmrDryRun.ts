// DB wiring for package capture and the BFMR submission DRY RUN. The decision
// logic is the pure lib/bfmrPackageMatch.ts. This file reads reservations and
// writes ONLY OrderPackage and BfmrDryRunLog rows. It must never import
// lib/bfmrWeb.ts or any BFMR client: there is no code path from here to a BFMR
// write (BFMR tracking stays manual, see lib/autoSubmitChannel.ts).
import { prisma } from '@/lib/db';
import type { ParsedPage } from '@/lib/amazonPageParse';
import type { PackageItem } from '@/lib/amazonPackages';
import { matchPackages, type PackageIn, type ReservationLineIn } from '@/lib/bfmrPackageMatch';
import { mergePackage, toDryRunEntry, type StoredPackage } from '@/lib/orderPackages';

const digits = (s: string) => s.replace(/\D/g, '');

function parseItems(json: string): PackageItem[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v as PackageItem[] : []; } catch { return []; }
}

/** Store the packages a captured page showed, under the matching local Amazon orders. Returns the order ids touched. */
export async function savePackages(userId: number, parsed: ParsedPage): Promise<number[]> {
  const withPkgs = parsed.orders.filter(o => o.packages && o.packages.length);
  if (!withPkgs.length) return [];
  const orders = await prisma.order.findMany({
    where: { userId, platform: 'Amazon', orderNumber: { in: withPkgs.map(o => o.orderNumber) } },
    select: { id: true, orderNumber: true },
  });
  const idByDigits = new Map(orders.filter(o => o.orderNumber).map(o => [digits(o.orderNumber as string), o.id]));
  const touched: number[] = [];
  for (const o of withPkgs) {
    const orderId = idByDigits.get(digits(o.orderNumber));
    if (orderId == null) continue;
    for (const p of o.packages ?? []) {
      const t = p.trackingNumber.trim();
      const row = await prisma.orderPackage.findUnique({ where: { orderId_trackingNumber: { orderId, trackingNumber: t } } });
      const existing: StoredPackage | null = row
        ? { trackingNumber: row.trackingNumber, carrier: row.carrier, itemsKnown: row.itemsKnown, items: parseItems(row.itemsJson) }
        : null;
      const m = mergePackage(existing, { ...p, trackingNumber: t });
      const data = { carrier: m.carrier, itemsKnown: m.itemsKnown, itemsJson: JSON.stringify(m.items), source: p.source, capturedAt: new Date() };
      if (row) await prisma.orderPackage.update({ where: { id: row.id }, data });
      else await prisma.orderPackage.create({ data: { userId, orderId, trackingNumber: t, ...data } });
    }
    touched.push(orderId);
  }
  return touched;
}

/**
 * Evaluate stored packages (for the given orders, or all when omitted) against
 * BFMR reservations and log what WOULD be submitted. Sends nothing anywhere.
 * An unchanged decision (same signature as the newest log row for that order +
 * tracking) is not logged again. Returns the number of new log rows.
 */
export async function runDryRun(userId: number, orderIds?: number[]): Promise<number> {
  const pkgRows = await prisma.orderPackage.findMany({
    where: { userId, ...(orderIds ? { orderId: { in: orderIds } } : {}) },
    include: { order: { select: { orderNumber: true } } },
  });
  if (!pkgRows.length) return 0;
  // Boxes shared with orders outside this batch must still be seen as shared.
  const trackings = [...new Set(pkgRows.map(p => p.trackingNumber))];
  const sharing = orderIds ? await prisma.orderPackage.findMany({
    where: { userId, trackingNumber: { in: trackings }, orderId: { notIn: orderIds } },
    include: { order: { select: { orderNumber: true } } },
  }) : [];
  const toIn = (p: (typeof pkgRows)[number]): PackageIn => ({
    orderId: p.orderId, orderNumber: p.order.orderNumber, trackingNumber: p.trackingNumber,
    itemsKnown: p.itemsKnown, items: parseItems(p.itemsJson),
  });
  const inputs = [...pkgRows, ...sharing].map(toIn);

  const resRows = await prisma.bfmrReservation.findMany({
    where: { userId },
    select: {
      id: true, reserveId: true, bfmrOrderId: true, itemName: true, dealTitle: true, qty: true, status: true, trackingNumber: true,
      orderLinks: { select: { orderId: true, quantity: true, trackingNumber: true } },
      submittedShipments: { select: { qty: true, trackingNumber: true } },
    },
  });
  const lines: ReservationLineIn[] = resRows.map(r => ({
    id: r.id, reserveId: r.reserveId, bfmrOrderId: r.bfmrOrderId, itemName: r.itemName, dealTitle: r.dealTitle,
    qty: r.qty, status: r.status, trackingNumber: r.trackingNumber,
    submitted: r.submittedShipments.map(s => ({ qty: s.qty, trackingNumber: s.trackingNumber })),
    links: r.orderLinks.map(l => ({ orderId: l.orderId, quantity: l.quantity, trackingNumber: l.trackingNumber })),
  }));

  const decisions = matchPackages(inputs, lines).slice(0, pkgRows.length); // sharing rows only add context
  let logged = 0;
  for (const d of decisions) {
    const e = toDryRunEntry(d);
    const last = await prisma.bfmrDryRunLog.findFirst({
      where: { userId, orderId: e.orderId, trackingNumber: e.trackingNumber }, orderBy: { id: 'desc' }, select: { signature: true },
    });
    if (last?.signature === e.signature) continue;
    await prisma.bfmrDryRunLog.create({
      data: {
        userId, orderId: e.orderId, orderNumber: e.orderNumber, trackingNumber: e.trackingNumber, decision: e.decision,
        reason: e.reason, message: e.message, wouldSubmit: JSON.stringify(e.wouldSubmit), caveats: JSON.stringify(e.caveats), signature: e.signature,
      },
    });
    logged++;
  }
  return logged;
}

/** Capture hook: never lets a package or dry-run failure break the Amazon capture itself. */
export async function recordPackagesAndDryRun(userId: number, parsed: ParsedPage): Promise<void> {
  try {
    const touched = await savePackages(userId, parsed);
    if (touched.length) await runDryRun(userId, touched);
  } catch (e) {
    console.error('[bfmr-dry-run] package capture failed:', e);
  }
}
