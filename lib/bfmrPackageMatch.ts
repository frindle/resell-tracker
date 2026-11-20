// Decide, per captured Amazon package, whether it lines up exactly with BFMR
// reservation line(s) or needs a human. Pure: no DB, no I/O, loads under
// `node --experimental-strip-types`.
//
// This module only DECIDES. Nothing here (or anything that calls it today)
// submits to BFMR: BFMR tracking stays manual-only (lib/autoSubmitChannel.ts).
// Its single consumer is the dry-run log (lib/bfmrDryRun.ts).
//
// Rules (full text in the dry-run page footer and the PR):
//  * A package is "exact" only when EVERY item in it maps to exactly one BFMR
//    reservation family (lines sharing a reserveId = a BFMR-side split) AND, per
//    family, the units across all of the order's readable packages equal the
//    units still left to submit on that family's lines. Over or under -> manual.
//  * Unknown items, a tracking number shared by several orders, a duplicate
//    tracking row, an already-submitted tracking number, an unmatched item, or
//    several candidate reservations are all manual, with a plain reason.
//  * Item titles are never assumed equal: a reservation matches a package item
//    only when enough distinctive words overlap.
import { normTracking, orderNumbersAgree, reservationContradictsOrder } from './bfmrLinkGuard.ts';

export interface PackageItemIn {
  title: string;
  quantity: number;
  /** quantity was not shown on the page and 1 was assumed */
  qtyAssumed?: boolean;
}

export interface PackageIn {
  orderId: number;
  orderNumber: string | null;
  trackingNumber: string;
  /** false = items could not be read; items is ignored */
  itemsKnown: boolean;
  items: PackageItemIn[];
}

export interface ReservationLineIn {
  id: number;
  /** lines of one BFMR-side split share this */
  reserveId: string | null;
  bfmrOrderId: string | null;
  itemName: string | null;
  dealTitle: string | null;
  qty: number;
  status: string;
  /** tracking BFMR already shows for the line */
  trackingNumber: string | null;
  /** tracking submissions already recorded locally (BfmrSubmittedShipment) */
  submitted: { qty: number; trackingNumber: string }[];
  /** OrderBfmrLink rows for this reservation */
  links: { orderId: number; quantity: number; trackingNumber: string | null }[];
}

export type ManualReason =
  | 'combined_order'
  | 'duplicate_package'
  | 'items_unknown'
  | 'bad_quantity'
  | 'no_candidate_reservation'
  | 'item_unmatched'
  | 'several_candidates'
  | 'reservation_not_eligible'
  | 'already_submitted'
  | 'quantity_over'
  | 'quantity_under'
  | 'ambiguous_lines';

export interface Allocation { reservationId: number; qty: number }

export type PackageDecision =
  | { decision: 'exact'; orderId: number; orderNumber: string | null; trackingNumber: string; allocations: Allocation[]; message: string; caveats: string[] }
  | { decision: 'manual'; orderId: number; orderNumber: string | null; trackingNumber: string; reason: ManualReason; message: string; allocations: []; caveats: string[] };

// Statuses where BFMR still wants tracking. Anything later (received, paid...)
// or terminal (cancelled, returned...) is not a submission target.
const OPEN_STATUSES = new Set(['purchased', 'reserved', 'shipped']);
const MAX_LINES = 10;

const STOP = new Set(['apple', 'with', 'and', 'the', 'for', 'new', 'usb', 'charging', 'case', 'model', 'inch', 'wireless', 'latest']);
const tokens = (s: string | null | undefined) =>
  new Set((s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 3 && !STOP.has(w)));

/** Does an Amazon item title name the same product as a BFMR item name? Needs distinctive-word overlap. */
export function itemNamesAgree(amazonTitle: string, bfmrName: string | null | undefined): boolean {
  const want = tokens(bfmrName);
  if (want.size === 0) return false;
  const have = tokens(amazonTitle);
  let shared = 0;
  for (const w of want) if (have.has(w)) shared++;
  // Model / size words (anything with a digit: 256gb, a3050, 11) must ALL appear:
  // "Widget Pro 256GB" is not "Widget Pro 512GB" however many other words agree.
  for (const w of want) if (/\d/.test(w) && !have.has(w)) return false;
  if (want.size === 1) return shared === 1;
  return shared >= 2 && shared / want.size >= 0.6;
}

const famKey = (l: ReservationLineIn) => (l.reserveId ? `r:${l.reserveId}` : `id:${l.id}`);
const eligible = (l: ReservationLineIn) => OPEN_STATUSES.has((l.status ?? '').toLowerCase().trim());
const submittedTotal = (l: ReservationLineIn) => l.submitted.reduce((s, r) => s + r.qty, 0);
const hasTracking = (l: ReservationLineIn, t: string) =>
  normTracking(l.trackingNumber) === t || l.submitted.some(r => normTracking(r.trackingNumber) === t);

/** Units of this line that this order may still send: its link share (or all) minus what was already submitted. */
function availableFor(l: ReservationLineIn, orderId: number): number {
  const mine = l.links.filter(k => k.orderId === orderId);
  const share = mine.length ? mine.reduce((s, k) => s + k.quantity, 0) : l.qty;
  return Math.max(0, Math.min(share, l.qty - submittedTotal(l)));
}

function candidateLines(orderId: number, orderNumber: string | null, all: ReservationLineIn[]): ReservationLineIn[] {
  return all.filter(l => {
    const linked = l.links.some(k => k.orderId === orderId);
    if (!linked && !orderNumbersAgree(l.bfmrOrderId, orderNumber)) return false;
    return !reservationContradictsOrder(l.bfmrOrderId, orderNumber);
  });
}

const sig = (p: PackageIn) => JSON.stringify(p.itemsKnown ? [...p.items].map(i => [i.title, i.quantity]).sort() : null);

/** Distinct ways to give each demand a set of whole lines (disjoint, summing to the demand). Counts up to 2. */
function assignLines(demands: number[], lines: { id: number; avail: number }[]): { count: number; first: number[][] | null } {
  let count = 0;
  let first: number[][] | null = null;
  const used = new Array(lines.length).fill(false);
  const picked: number[][] = [];
  const place = (d: number) => {
    if (count >= 2) return;
    if (d === demands.length) {
      if (used.every(Boolean)) { count++; if (!first) first = picked.map(p => [...p]); }
      return;
    }
    const n = lines.length;
    for (let mask = 1; mask < (1 << n); mask++) {
      let sum = 0; let clash = false;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) { if (used[i]) clash = true; sum += lines[i].avail; }
      if (clash || sum !== demands[d]) continue;
      const ids: number[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) { used[i] = true; ids.push(lines[i].id); }
      picked.push(ids);
      place(d + 1);
      picked.pop();
      for (let i = 0; i < n; i++) if (mask & (1 << i)) used[i] = false;
    }
  };
  place(0);
  return { count, first };
}

export function matchPackages(packages: PackageIn[], reservations: ReservationLineIn[]): PackageDecision[] {
  const out: (PackageDecision | null)[] = packages.map(() => null);
  const manual = (i: number, reason: ManualReason, message: string, caveats: string[] = []) => {
    const p = packages[i];
    out[i] = { decision: 'manual', orderId: p.orderId, orderNumber: p.orderNumber, trackingNumber: p.trackingNumber, reason, message, allocations: [], caveats };
  };

  // 1. package-level problems
  const byTracking = new Map<string, number[]>();
  packages.forEach((p, i) => {
    const t = normTracking(p.trackingNumber);
    byTracking.set(t, [...(byTracking.get(t) ?? []), i]);
  });
  packages.forEach((p, i) => {
    const t = normTracking(p.trackingNumber);
    const same = byTracking.get(t) ?? [];
    const orders = new Set(same.map(j => packages[j].orderId));
    if (orders.size > 1) return manual(i, 'combined_order', `tracking ${t} appears under ${orders.size} orders (one box holds several orders); submit by hand`);
    if (same.length > 1) {
      return manual(i, 'duplicate_package', same.every(j => sig(packages[j]) === sig(p))
        ? `tracking ${t} is recorded twice for this order; not submitting either copy`
        : `tracking ${t} is recorded twice for this order with different items; not submitting either`);
    }
    if (!t) return manual(i, 'items_unknown', 'package has no tracking number');
    if (!p.itemsKnown || p.items.length === 0) return manual(i, 'items_unknown', 'the items in this package could not be read from Amazon; submit by hand');
    if (p.items.some(it => !Number.isInteger(it.quantity) || it.quantity < 1)) return manual(i, 'bad_quantity', 'a quantity in this package is missing or not a whole number');
  });

  // 2. per order: map each item to a reservation family
  const orderIds = [...new Set(packages.filter((_, i) => !out[i]).map(p => p.orderId))];
  for (const orderId of orderIds) {
    const idxs = packages.map((_, i) => i).filter(i => packages[i].orderId === orderId);
    const orderNumber = packages[idxs[0]].orderNumber;
    const lines = candidateLines(orderId, orderNumber, reservations);
    const unresolved = idxs.filter(i => out[i] && ['items_unknown', 'combined_order', 'bad_quantity', 'duplicate_package'].includes((out[i] as { reason?: string }).reason ?? '')).length;
    const pending = idxs.filter(i => !out[i]);
    const famQty = new Map<number, Map<string, number>>(); // package idx -> family -> units

    for (const i of pending) {
      const p = packages[i];
      const t = normTracking(p.trackingNumber);
      if (!lines.length) { manual(i, 'no_candidate_reservation', 'no BFMR reservation is linked to this order'); continue; }
      const perFam = new Map<string, number>();
      let failed = false;
      for (const it of p.items) {
        const fams = new Set(lines.filter(l => itemNamesAgree(it.title, l.itemName ?? l.dealTitle)).map(famKey));
        if (fams.size === 0) { manual(i, 'item_unmatched', `an item in this package matches no BFMR reservation on this order, so it cannot be tied to one`); failed = true; break; }
        if (fams.size > 1) { manual(i, 'several_candidates', `an item in this package fits ${fams.size} different BFMR reservations; submit by hand`); failed = true; break; }
        const f = [...fams][0];
        perFam.set(f, (perFam.get(f) ?? 0) + it.quantity);
      }
      if (failed) continue;
      for (const f of perFam.keys()) {
        const fl = lines.filter(l => famKey(l) === f);
        if (fl.some(l => hasTracking(l, t))) { manual(i, 'already_submitted', `tracking ${t} is already on this BFMR reservation`); failed = true; break; }
        if (!fl.some(eligible)) { manual(i, 'reservation_not_eligible', `the BFMR reservation is "${fl[0].status}", not waiting for tracking`); failed = true; break; }
      }
      if (!failed) famQty.set(i, perFam);
    }

    // 3. per family: package units must equal units left to submit
    const fams = new Set<string>();
    famQty.forEach(m => m.forEach((_, f) => fams.add(f)));
    const famResult = new Map<string, { ok: true; perPkg: Map<number, Allocation[]> } | { ok: false; reason: ManualReason; message: string }>();
    for (const f of fams) {
      const users = [...famQty.entries()].filter(([, m]) => m.has(f)).map(([i, m]) => ({ i, q: m.get(f) as number }));
      const fl = lines.filter(l => famKey(l) === f && eligible(l)).map(l => ({ id: l.id, avail: availableFor(l, orderId) })).filter(l => l.avail > 0);
      const N = users.reduce((s, u) => s + u.q, 0);
      const R = fl.reduce((s, l) => s + l.avail, 0);
      if (R === 0) { famResult.set(f, { ok: false, reason: 'already_submitted', message: 'the BFMR reservation has no units left to submit' }); continue; }
      if (N > R) { famResult.set(f, { ok: false, reason: 'quantity_over', message: `packages show ${N} unit(s) but only ${R} are left to submit on the BFMR reservation` }); continue; }
      if (N < R) {
        famResult.set(f, { ok: false, reason: 'quantity_under', message: `packages account for ${N} of ${R} unit(s) on the BFMR reservation${unresolved ? ' (other packages on this order could not be read)' : ''}; partial shipments are submitted by hand` });
        continue;
      }
      const perPkg = new Map<number, Allocation[]>();
      if (fl.length === 1) {
        for (const u of users) perPkg.set(u.i, [{ reservationId: fl[0].id, qty: u.q }]);
      } else {
        if (fl.length > MAX_LINES) { famResult.set(f, { ok: false, reason: 'ambiguous_lines', message: 'too many reservation lines to match safely' }); continue; }
        const a = assignLines(users.map(u => u.q), fl);
        if (a.count !== 1 || !a.first) {
          famResult.set(f, { ok: false, reason: 'ambiguous_lines', message: a.count === 0
            ? 'the package sizes cannot be matched to whole BFMR reservation lines (a line would have to be split)'
            : 'more than one way to assign these packages to the split BFMR lines; submit by hand' });
          continue;
        }
        users.forEach((u, k) => perPkg.set(u.i, (a.first as number[][])[k].map(id => ({ reservationId: id, qty: fl.find(l => l.id === id)!.avail }))));
      }
      famResult.set(f, { ok: true, perPkg });
    }

    // 4. assemble per-package outcome
    for (const [i, m] of famQty) {
      const p = packages[i];
      const allocations: Allocation[] = [];
      let bad: { reason: ManualReason; message: string } | null = null;
      for (const f of m.keys()) {
        const r = famResult.get(f)!;
        if (!r.ok) { bad = r; break; }
        allocations.push(...(r.perPkg.get(i) ?? []));
      }
      if (bad) { manual(i, bad.reason, bad.message); continue; }
      const caveats: string[] = [];
      if (p.items.some(it => it.qtyAssumed)) caveats.push('a quantity was not shown on the Amazon page and 1 was assumed');
      const units = allocations.reduce((s, a) => s + a.qty, 0);
      out[i] = {
        decision: 'exact', orderId: p.orderId, orderNumber: p.orderNumber, trackingNumber: p.trackingNumber, allocations, caveats,
        message: `${units} unit(s) in this package match ${allocations.length} BFMR reservation line(s) exactly`,
      };
    }
  }
  return out.map((d, i) => d ?? { decision: 'manual', orderId: packages[i].orderId, orderNumber: packages[i].orderNumber, trackingNumber: packages[i].trackingNumber, reason: 'items_unknown' as const, message: 'not evaluated', allocations: [] as [], caveats: [] });
}
