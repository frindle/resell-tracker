// DB wiring for package capture and the BFMR submission DRY RUN. The decision
// logic is the pure lib/bfmrPackageMatch.ts. This file reads reservations and
// writes ONLY OrderPackage and BfmrDryRunLog rows. It must never import
// lib/bfmrWeb.ts or any BFMR client. After the evaluation, the capture hook
// hands the touched orders to lib/bfmrAutoSubmit.ts, which is the only place
// that may send anything (off / plan / on, see that file).
import { prisma } from '@/lib/db';
import type { ParsedPage } from '@/lib/amazonPageParse';
import type { PackageItem } from '@/lib/amazonPackages';
import { matchPackages, type PackageDecision, type PackageIn, type ReservationLineIn } from '@/lib/bfmrPackageMatch';
import { withoutOwnSubmission } from '@/lib/bfmrAutoSubmitPlan';
import { runAutoSubmit } from '@/lib/bfmrAutoSubmit';
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

export interface Evaluation {
  /** the stored packages evaluated, in the same order as `decisions` */
  packages: { id: number; orderId: number; orderNumber: string | null; trackingNumber: string }[];
  decisions: PackageDecision[];
  lines: ReservationLineIn[];
}

/**
 * Evaluate stored packages (for the given orders, or all when omitted) against
 * BFMR reservations. Read-only. With `excludeOwnSubmission`, each package is
 * judged as if its own recorded submission did not exist (used by the replay to
 * compare against what was submitted by hand).
 */
export async function evaluatePackages(userId: number, orderIds?: number[], opts: { excludeOwnSubmission?: boolean } = {}): Promise<Evaluation | null> {
  const pkgRows = await prisma.orderPackage.findMany({
    where: { userId, ...(orderIds ? { orderId: { in: orderIds } } : {}) },
    include: { order: { select: { orderNumber: true } } },
    orderBy: { id: 'asc' },
  });
  if (!pkgRows.length) return null;
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

  const decisions = opts.excludeOwnSubmission
    ? pkgRows.map((p, k) => matchPackages(inputs, withoutOwnSubmission(lines, p.trackingNumber))[k])
    : matchPackages(inputs, lines).slice(0, pkgRows.length); // sharing rows only add context
  return {
    packages: pkgRows.map(p => ({ id: p.id, orderId: p.orderId, orderNumber: p.order.orderNumber, trackingNumber: p.trackingNumber })),
    decisions, lines,
  };
}

/** Log decisions that changed since the last logged one for that order + tracking. Returns the number of new rows. */
export async function logDecisions(userId: number, decisions: PackageDecision[]): Promise<number> {
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

/** Evaluate and log what WOULD be submitted. Sends nothing anywhere. Returns the number of new log rows. */
export async function runDryRun(userId: number, orderIds?: number[]): Promise<number> {
  const ev = await evaluatePackages(userId, orderIds);
  return ev ? logDecisions(userId, ev.decisions) : 0;
}

/**
 * Capture hook: never lets a package, dry-run or auto-submit failure break the
 * Amazon capture itself. After the evaluation, the touched orders go to the
 * guarded auto-submit (mode off / plan / on).
 */
export async function recordPackagesAndDryRun(userId: number, parsed: ParsedPage): Promise<void> {
  try {
    const touched = await savePackages(userId, parsed);
    if (!touched.length) return;
    const ev = await evaluatePackages(userId, touched);
    if (!ev) return;
    await logDecisions(userId, ev.decisions);
    await runAutoSubmit(userId, ev.decisions);
  } catch (e) {
    console.error('[bfmr-dry-run] package capture failed:', e);
  }
}
