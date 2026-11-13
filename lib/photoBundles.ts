// Unsorted photos of the same purchase, grouped so Sort & Assign can attach
// them in one go: a Costco receipt, its activation slip and each card pack.
// Pure, no I/O.
//
// Two photos are one set when:
//   - they point at the same order (exact or likely match), or
//   - before that order exists, their drafted new orders carry the same order
//     number (for Costco, the same warehouse/register/transaction in the
//     barcode), or
//   - a photo that matched nothing prints the Costco transaction of a drafted
//     receipt uploaded within a few days of it (the card packs' slips).
import { costcoTransactions, parseCostcoBarcode, type CostcoTxn } from './photoMatch.ts';

export type BundlePhoto = {
  id: number;
  createdAt: Date | string;
  status: string | null;
  manual?: boolean | null;
  strength: string | null;
  suggestedOrderId: number | null;
  draft?: { orderNumber?: string | null; itemDescription?: string | null; cardId?: number | null; cost?: string | null } | null;
  lines: string[];
};

export type PhotoBundle = { key: string; leadId: number; ids: number[] };

const DAY = 86_400_000;
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const txnKey = (t: CostcoTxn) => `c:${t.warehouse}-${t.register}-${t.transaction}`;

/** The photo a set is shown and decided by: the surest match, or the fullest draft. */
function leadOf(members: BundlePhoto[]): number {
  const score = (p: BundlePhoto) => {
    if (p.suggestedOrderId != null) return p.strength === 'exact' ? 100 : 90;
    const d = p.draft;
    if (!d) return 0;
    return 10 + (d.orderNumber ? 8 : 0) + (d.itemDescription?.includes('$') ? 4 : 0) + (d.cardId != null ? 2 : 0) + (d.itemDescription ? 1 : 0);
  };
  return [...members].sort((a, b) => score(b) - score(a) || +new Date(a.createdAt) - +new Date(b.createdAt))[0].id;
}

/** Sets of two or more photos, each with the photo that leads it. */
export function photoBundles(photos: BundlePhoto[]): PhotoBundle[] {
  const open = photos.filter(p => p.status === 'done' && !p.manual);
  const key = new Map<number, string>();
  for (const p of open) {
    if (p.suggestedOrderId != null && (p.strength === 'exact' || p.strength === 'likely')) key.set(p.id, `o:${p.suggestedOrderId}`);
  }
  // Drafted new orders: one purchase when the order numbers agree.
  const anchors: { key: string; at: number }[] = [];
  for (const p of open) {
    const n = p.draft?.orderNumber;
    if (key.has(p.id) || p.suggestedOrderId != null || !n) continue;
    const t = parseCostcoBarcode(n);
    const k = t ? txnKey(t) : `n:${norm(n)}`;
    key.set(p.id, k);
    if (t) anchors.push({ key: k, at: +new Date(p.createdAt) });
  }
  // Photos with nothing else to go on that print a drafted receipt's Costco
  // transaction. Transaction numbers repeat across days, so only near the
  // receipt's upload.
  for (const p of open) {
    if (key.has(p.id) || p.suggestedOrderId != null) continue;
    const txns = costcoTransactions(p.lines);
    if (txns.length !== 1) continue;
    const k = txnKey(txns[0]);
    const at = +new Date(p.createdAt);
    if (anchors.some(a => a.key === k && Math.abs(a.at - at) <= 3 * DAY)) key.set(p.id, k);
  }
  const groups = new Map<string, BundlePhoto[]>();
  for (const p of open) {
    const k = key.get(p.id);
    if (k) groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups].filter(([, ms]) => ms.length > 1)
    .map(([k, ms]) => ({ key: k, leadId: leadOf(ms), ids: ms.map(m => m.id) }));
}
