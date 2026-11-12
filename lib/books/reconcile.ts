// The reconciler: diff what each source should have posted (desired state)
// against what is posted (latest live entry per sourceKey, by content hash) and
// post reversals / new entries. Idempotent: a second run posts nothing.
import type { BooksStore } from './types.ts';
import { type DesiredEntry, hashEntry } from './desired.ts';
import { postEntry, reverseEntry } from './ledger.ts';
import { type OpeningInput, buildOpening } from './opening.ts';
import {
  type OrderForBooks, desiredOrderEntries, eventsReached, stampDate,
} from './orderPostings.ts';

export type ReconcileResult = { posted: number; reversed: number; errors: string[] };

export async function applyDesired(
  store: BooksStore,
  userId: number,
  desired: DesiredEntry[],
  scope: { prefix: string; only?: string[] },
  now: Date,
): Promise<ReconcileResult> {
  const res: ReconcileResult = { posted: 0, reversed: 0, errors: [] };
  const want = new Map(desired.filter(d => d.lines.some(l => l.amountCents !== 0)).map(d => [d.sourceKey, d]));
  const live = await store.livePosted(userId, scope.prefix);
  const only = scope.only ? new Set(scope.only) : null;
  const liveByKey = new Map<string, typeof live>();
  for (const e of live) {
    if (only && !only.has(e.sourceKey)) continue;
    (liveByKey.get(e.sourceKey) ?? liveByKey.set(e.sourceKey, []).get(e.sourceKey)!).push(e);
  }
  const keys = new Set<string>([...liveByKey.keys(), ...(only ? [...only].filter(k => want.has(k)) : [...want.keys()])]);

  for (const key of keys) {
    const d = want.get(key) ?? null;
    const hash = d ? hashEntry(d) : null;
    // Cheap pre-check on the (possibly stale) snapshot: already exactly right, nothing to do.
    const snap = liveByKey.get(key) ?? [];
    if (d && snap.length === 1 && snap[0].contentHash === hash) continue;
    try {
      const n = await store.transaction(async tx => {
        let rev = 0, pst = 0;
        // Re-read inside the transaction: an overlapping run may have reversed / re-posted this key since the snapshot.
        const posted = (await tx.livePosted(userId, key)).filter(e => e.sourceKey === key);
        if (d && posted.length === 1 && posted[0].contentHash === hash) return { rev, pst };
        for (const e of posted) { await reverseEntry(tx, userId, e, now); rev++; }
        if (d) {
          await postEntry(tx, userId, {
            date: d.date, memo: d.memo, source: d.source, sourceKey: d.sourceKey, contentHash: hash!, lines: d.lines,
          });
          pst++;
        }
        return { rev, pst };
      });
      res.reversed += n.rev;
      res.posted += n.pst;
    } catch (e) {
      res.errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return res;
}

/** orderId -> inventory cents the opening entry carried for it. */
export async function openingInventoryByOrder(store: BooksStore, userId: number): Promise<Map<number, number> | null> {
  const out = new Map<number, number>();
  const live = await store.livePosted(userId, 'opening');
  if (live.length === 0) return null;
  const goods = await store.resolveAccount(userId, 'inventory_goods');
  const gifts = await store.resolveAccount(userId, 'inventory_giftcards');
  for (const e of live) {
    for (const l of e.lines) {
      if (l.orderId != null && (l.accountId === goods.id || l.accountId === gifts.id)) {
        out.set(l.orderId, (out.get(l.orderId) ?? 0) + l.amountCents);
      }
    }
  }
  return out;
}

/** Stamp new events, compute every order's desired entries, and apply the diff. */
export async function reconcileOrders(
  store: BooksStore,
  userId: number,
  orders: OrderForBooks[],
  opts: { goLive: string; now: Date },
): Promise<ReconcileResult> {
  const { goLive, now } = opts;
  const events = await store.eventDates(orders.map(o => o.id));
  const today = stampDate(now);
  for (const o of orders) {
    const have = events.get(o.id) ?? new Map<string, string>();
    for (const ev of eventsReached(o, now)) {
      if (!have.has(ev)) {
        await store.stampEvent(o.id, ev, today);
        have.set(ev, today);
      }
    }
    events.set(o.id, have);
  }
  const opening = await openingInventoryByOrder(store, userId);
  const desired: DesiredEntry[] = [];
  for (const o of orders) {
    desired.push(...desiredOrderEntries(o, {
      goLive, now, events: events.get(o.id) ?? new Map(), openingInv: opening ? (opening.get(o.id) ?? 0) : null,
    }));
  }
  return applyDesired(store, userId, desired, { prefix: 'order:' }, now);
}

/** (Re)build the opening entry. Re-running replaces it through a reversal. Stamps pre-go-live events first. */
export async function reconcileOpening(
  store: BooksStore,
  userId: number,
  orders: OrderForBooks[],
  input: OpeningInput,
  opts: { goLive: string; now: Date },
): Promise<ReconcileResult & { inventoryCents: number; receivableCents: number }> {
  const events = await store.eventDates(orders.map(o => o.id));
  const built = buildOpening(orders, input, { goLive: opts.goLive, now: opts.now, events });
  for (const s of built.stamps) await store.stampEvent(s.orderId, s.event, s.date);
  const r = await applyDesired(store, userId, built.desired, { prefix: 'opening' }, opts.now);
  return { ...r, inventoryCents: built.inventoryCents, receivableCents: built.receivableCents };
}
