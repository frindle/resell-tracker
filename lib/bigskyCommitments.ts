// BigSky commitments: check and normalize commitmentFulfillment.getUserFulfillment
// rows, tie each fulfillment to the scanned package that filled it, and find the
// tracker's orders for those packages. Pure, no I/O.
//
// A fulfillment names a scanId, but scan.getScanByUser rows carry no id. They do
// carry itemUpc and scanDate, and a fulfillment's date is its scan's scanDate to
// the millisecond (114 of 114 on 2026-11-14), so UPC + time finds the scan, and
// with it the tracking number. Several boxes of one UPC scanned in the same
// instant all match; every one of their tracking numbers is kept.

export type BigSkyFulfillment = {
  id: string;
  quantity: number;
  date: string;
  scanId: string;
  trackingNumbers: string[];
};

export type BigSkyCommitmentRow = {
  commitmentId: string;
  dealId: string;
  itemName: string;
  itemUpc: string;
  dealPrice: number;
  commitmentAmount: number;
  fulfilled: number;
  commitmentsRemaining: number;
  status: string;
  dealCreated: Date | null;
  dealExpiration: Date | null;
  creationDate: Date | null;
  fulfillmentDate: Date | null;
  fulfillments: BigSkyFulfillment[];
  raw: unknown;
};

const text = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const when = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
};

function parseFulfillment(v: unknown): BigSkyFulfillment | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const quantity = num(d.quantity);
  const date = when(d.date);
  if (quantity == null || !date) return null;
  return { id: text(d.id), quantity, date: date.toISOString(), scanId: text(d.scanId), trackingNumbers: [] };
}

/**
 * BigSky rows the tracker can store. A row without an id, deal, price or counts
 * is skipped (and counted) rather than stored half-filled.
 */
export function parseFulfillmentRows(raw: readonly unknown[]): { rows: BigSkyCommitmentRow[]; skipped: number } {
  const rows: BigSkyCommitmentRow[] = [];
  let skipped = 0;
  for (const v of raw) {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const commitmentId = text(r.commitmentId);
    const dealId = text(r.dealId);
    const dealPrice = num(r.dealPrice);
    const commitmentAmount = num(r.commitmentAmount);
    const fulfilled = num(r.fulfilled);
    if (!commitmentId || !dealId || dealPrice == null || commitmentAmount == null || fulfilled == null) {
      skipped++;
      continue;
    }
    const details = Array.isArray(r.fulfillmentDetails) ? r.fulfillmentDetails : [];
    rows.push({
      commitmentId,
      dealId,
      itemName: text(r.itemName),
      itemUpc: text(r.itemUpc),
      dealPrice,
      commitmentAmount: Math.round(commitmentAmount),
      fulfilled: Math.round(fulfilled),
      commitmentsRemaining: Math.round(num(r.commitmentsRemaining) ?? Math.max(0, commitmentAmount - fulfilled)),
      status: text(r.status) || 'UNKNOWN',
      dealCreated: when(r.dealCreated),
      dealExpiration: when(r.dealExpiration),
      creationDate: when(r.creationDate),
      fulfillmentDate: when(r.fulfillmentDate),
      fulfillments: details.map(parseFulfillment).filter((f): f is BigSkyFulfillment => f !== null),
      raw: v,
    });
  }
  return { rows, skipped };
}

type ScanRef = { trackingNumber: string; itemUpc?: string; scanDate: string };

const scanKey = (upc: string, iso: string) => `${upc.trim()}|${Date.parse(iso)}`;

/** Each fulfillment's tracking numbers, from the scans with its UPC and scan time. */
export function attachScanTracking(rows: readonly BigSkyCommitmentRow[], scans: readonly ScanRef[]): BigSkyCommitmentRow[] {
  const byKey = new Map<string, string[]>();
  for (const s of scans) {
    if (!s.itemUpc || !s.trackingNumber) continue;
    const k = scanKey(s.itemUpc, s.scanDate);
    const list = byKey.get(k) ?? [];
    if (!list.includes(s.trackingNumber)) list.push(s.trackingNumber);
    byKey.set(k, list);
  }
  return rows.map(r => ({
    ...r,
    fulfillments: r.fulfillments.map(f => ({ ...f, trackingNumbers: [...(byKey.get(scanKey(r.itemUpc, f.date)) ?? [])] })),
  }));
}

/** Tracking number as compared across sources: letters and digits only, upper case. */
export function trackingKey(t: string): string {
  return String(t ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Same package: equal, or one ends with the other (a USPS barcode puts 420 + ZIP
 * in front). The shorter side needs 12+ characters so a short code never
 * matches the tail of an unrelated number.
 */
export function sameTracking(a: string, b: string): boolean {
  const x = trackingKey(a), y = trackingKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.endsWith(short);
}

/** Ids of the orders that carry any of `trackingNumbers`, in the orders' order. */
export function ordersForTracking<T extends { id: number; trackingNumbers: string | null }>(
  orders: readonly T[],
  trackingNumbers: readonly string[],
): T[] {
  if (trackingNumbers.length === 0) return [];
  return orders.filter(o =>
    (o.trackingNumbers ?? '').split(',').map(s => s.trim()).filter(Boolean)
      .some(t => trackingNumbers.some(n => sameTracking(t, n))),
  );
}
