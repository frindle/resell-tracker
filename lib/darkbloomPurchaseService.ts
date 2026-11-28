// Database and HTTP side of lib/darkbloomPurchase.ts: mark an order as a Darkbloom purchase, push it to bloom-ledger as a
// cost entry, void it again. Env: BLOOM_LEDGER_URL (address) and BLOOM_LEDGER_TOKEN (a ledger API key; sent as a Bearer
// header, never logged or stored). Everything is a small state machine on the Order row, so a retry from the timer, a click
// or a restart can run it again at any point without posting twice. Tests inject `fetch` and the capture request.
import { isItemSummary } from './itemSummary.ts';
import { prisma } from '@/lib/db';
import { createHash } from 'node:crypto';
import { formatOrderDateIso } from '@/lib/formatOrderDate';
import {
  buildEntry, chargeCents, entrySig, isBloomCategory, itemLines, planPush, DEFAULT_CATEGORY,
  type PackageItems, type PurchaseOrder, type BloomCategory,
} from '@/lib/darkbloomPurchase';

type Resp = { status: number; ok: boolean; text(): Promise<string> };
export type Deps = {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Resp>;
  url: string | undefined; token: string | undefined;
  /** Ask the browser extension to read the merchant's order page (fills items, amount, card). */
  requestCapture: (userId: number, o: { id: number; platform: string; orderNumber: string | null; sourceUrl: string | null }) => Promise<void>;
};

export function envDeps(): Deps {
  return {
    fetch: (url, init) => fetch(url, init) as Promise<Resp>,
    url: process.env.BLOOM_LEDGER_URL?.trim().replace(/\/+$/, '') || undefined,
    token: process.env.BLOOM_LEDGER_TOKEN?.trim() || undefined,
    requestCapture: async (userId, o) => {
      if (o.platform !== 'Amazon' || !o.orderNumber) return;
      const { queueDetailVisit } = await import('@/lib/amazonVisitQueue');
      await queueDetailVisit(userId, o.orderNumber, o.sourceUrl);
    },
  };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

async function call(d: Deps, path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; json: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await d.fetch(`${d.url}${path}`, {
      method, signal: ctl.signal,
      headers: { Authorization: `Bearer ${d.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown = null;
    try { json = JSON.parse(await r.text()); } catch { /* not JSON */ }
    return { status: r.status, json };
  } finally { clearTimeout(timer); }
}

const ROW = {
  id: true, userId: true, platform: true, orderNumber: true, orderDate: true, cost: true, shippingCost: true, taxAmount: true,
  subtotalAmount: true, itemDescription: true, sourceUrl: true, darkbloomCategory: true, darkbloomMachineId: true, bloomEntryId: true,
  bloomPushedSig: true, bloomRev: true, bloomPushNote: true, cancelled: true, card: { select: { last4: true } }, packages: { select: { itemsKnown: true, itemsJson: true } },
} as const;

function packageItems(rows: { itemsKnown: boolean; itemsJson: string }[]): PackageItems[] {
  const out: PackageItems[] = [];
  for (const r of rows) {
    if (!r.itemsKnown) continue;
    try { const v = JSON.parse(r.itemsJson); if (Array.isArray(v)) out.push(v.filter(x => x && typeof x.title === 'string')); } catch { /* skip */ }
  }
  return out;
}

async function load(id: number) {
  const r = await prisma.order.findUnique({ where: { id }, select: ROW });
  if (!r) return null;
  const o: PurchaseOrder = {
    id: r.id, platform: r.platform, orderNumber: r.orderNumber, orderDate: formatOrderDateIso(r.orderDate), cost: r.cost, shippingCost: r.shippingCost,
    taxAmount: r.taxAmount, subtotalAmount: r.subtotalAmount, itemDescription: r.itemDescription, cardLast4: r.card?.last4 ?? null,
    darkbloomCategory: r.darkbloomCategory, darkbloomMachineId: r.darkbloomMachineId, bloomEntryId: r.bloomEntryId,
    bloomPushedSig: r.bloomPushedSig, bloomRev: r.bloomRev, cancelled: r.cancelled,
  };
  return { row: r, o, lines: itemLines(r.itemDescription, packageItems(r.packages)) };
}

const note = (id: number, bloomPushNote: string | null) => prisma.order.update({ where: { id }, data: { bloomPushNote } });
const entryId = (j: unknown): number | null => {
  const v = j && typeof j === 'object' ? (j as Record<string, unknown>).id : null;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
};

export type PushResult = 'none' | 'synced' | 'posted' | 'reposted' | 'voided' | 'waiting' | 'pending' | 'error';

/** Void one ledger entry. An entry already gone or voided (404, 409) counts as done. */
async function voidEntry(d: Deps, id: number): Promise<'ok' | 'auth' | 'error'> {
  const r = await call(d, '/v1/accounting/entries/void', 'POST', { id });
  if (r.status === 401) return 'auth';
  return r.status >= 200 && r.status < 300 || r.status === 404 || r.status === 409 ? 'ok' : 'error';
}

/** Bring one order's ledger entry in line with the order. Safe to call any number of times. */
export async function pushOrder(orderId: number, d: Deps = envDeps()): Promise<PushResult> {
  const cur = await load(orderId);
  if (!cur) return 'none';
  const { o, lines } = cur;
  const entry = lines ? buildEntry(o, lines) : null;
  const plan = planPush({
    marked: o.darkbloomCategory != null, cancelled: o.cancelled, entryId: o.bloomEntryId, pushedSig: o.bloomPushedSig,
    lines, amountCents: chargeCents(o), sig: entry ? sha(entrySig(entry)) : null, url: !!d.url, token: !!d.token,
  });
  switch (plan.do) {
    case 'none': return 'none';
    case 'synced': if (cur.row.bloomPushNote !== null) await note(orderId, null); return 'synced';
    case 'wait': await note(orderId, plan.why === 'items' ? 'items' : 'amount'); return 'waiting';
    case 'pending': await note(orderId, plan.why); return 'pending';
    case 'void': {
      const v = await voidEntry(d, o.bloomEntryId!);
      if (v !== 'ok') { await note(orderId, v === 'auth' ? 'auth' : 'void failed; will retry'); return v === 'auth' ? 'pending' : 'error'; }
      await prisma.order.update({ where: { id: orderId }, data: { bloomEntryId: null, bloomPushedSig: null, bloomSyncedAt: null, bloomPushNote: null, ...(o.darkbloomCategory == null ? { darkbloomMachineId: null } : {}) } });
      return 'voided';
    }
    case 'repost': {
      const v = await voidEntry(d, o.bloomEntryId!);
      if (v !== 'ok') { await note(orderId, v === 'auth' ? 'auth' : 'void failed; will retry'); return v === 'auth' ? 'pending' : 'error'; }
      // The old entry is void: record that before posting, so a crash here cannot leave a stale id behind. The fresh ref keeps the ledger from handing back the voided entry.
      const rev = o.bloomRev + 1;
      await prisma.order.update({ where: { id: orderId }, data: { bloomEntryId: null, bloomPushedSig: null, bloomRev: rev } });
      return post(orderId, { ...o, bloomEntryId: null, bloomRev: rev }, lines!, d, 'reposted');
    }
    case 'post': return post(orderId, o, lines!, d, 'posted');
  }
}

async function post(orderId: number, o: PurchaseOrder, lines: NonNullable<ReturnType<typeof itemLines>>, d: Deps, ok: 'posted' | 'reposted'): Promise<PushResult> {
  const entry = buildEntry(o, lines);
  let r: { status: number; json: unknown };
  try { r = await call(d, '/v1/accounting/entries', 'POST', entry); } catch (e) {
    await note(orderId, `ledger unreachable (${e instanceof Error ? e.name : 'error'})`); return 'error';
  }
  if (r.status === 401) { await note(orderId, 'auth'); return 'pending'; }
  const id = entryId(r.json);
  if (r.status < 200 || r.status >= 300 || id == null) { await note(orderId, `ledger answered ${r.status}`); return 'error'; }
  await prisma.order.update({ where: { id: orderId }, data: { bloomEntryId: id, bloomPushedSig: sha(entrySig(entry)), bloomSyncedAt: new Date(), bloomPushNote: null } });
  return ok;
}

/** Move the order's bank links between Personal and Darkbloom cost, and re-post the books. Best effort: the mark itself stands. */
async function reclassBank(userId: number, orderId: number, to: 'darkbloom_cost' | 'personal') {
  try { const { reclassOrderLinks } = await import('./books/bank/service.ts'); await reclassOrderLinks(userId, orderId, to); }
  catch (e) { console.error('[darkbloom] bank reclass failed:', String(e).slice(0, 120)); }
}

export type MarkResult = { marked: number; skipped: number };

/** Mark orders as Darkbloom purchases. Keeps them out of resell's P&L (ignoredByRule), asks for item details when needed, then pushes. */
export async function markPurchases(userId: number, ids: number[], category: string | undefined, machineId: string | undefined, d: Deps = envDeps()): Promise<MarkResult> {
  const cat: BloomCategory = category === undefined ? DEFAULT_CATEGORY : (isBloomCategory(category) ? category : (() => { throw new Error('unknown category'); })());
  const machine = cat === 'hardware' && machineId ? machineId.slice(0, 80) : null;
  const rows = await prisma.order.findMany({ where: { id: { in: ids }, userId }, select: { id: true } });
  for (const r of rows) {
    await prisma.order.update({ where: { id: r.id }, data: { darkbloomCategory: cat, darkbloomMachineId: machine, ignoredByRule: true } });
    await reclassBank(userId, r.id, 'darkbloom_cost');
    const cur = await load(r.id);
    if (cur && !cur.lines) await d.requestCapture(userId, { id: cur.row.id, platform: cur.row.platform, orderNumber: cur.row.orderNumber, sourceUrl: cur.row.sourceUrl }).catch(e => console.error('[darkbloom] capture request failed:', String(e).slice(0, 120)));
    await pushOrder(r.id, d).catch(e => console.error('[darkbloom] push failed:', String(e).slice(0, 120)));
  }
  return { marked: rows.length, skipped: ids.length - rows.length };
}

/** Undo: the order is no longer a Darkbloom purchase; a pushed entry is voided (now, or on the next retry). */
export async function unmarkPurchases(userId: number, ids: number[], d: Deps = envDeps()): Promise<{ unmarked: number }> {
  const rows = await prisma.order.findMany({ where: { id: { in: ids }, userId, OR: [{ darkbloomCategory: { not: null } }, { bloomEntryId: { not: null } }] }, select: { id: true, blockedAddressPattern: true } });
  for (const r of rows) {
    await prisma.order.update({ where: { id: r.id }, data: { darkbloomCategory: null, bloomPushNote: null, ...(r.blockedAddressPattern == null ? { ignoredByRule: false } : {}) } });
    await reclassBank(userId, r.id, 'personal');
    await pushOrder(r.id, d).catch(e => console.error('[darkbloom] void failed:', String(e).slice(0, 120)));
  }
  return { unmarked: rows.length };
}

/** Ask for the merchant page again (the "Fetch item details" button). */
export async function requestItems(userId: number, ids: number[], d: Deps = envDeps()): Promise<number> {
  const rows = await prisma.order.findMany({ where: { id: { in: ids }, userId, darkbloomCategory: { not: null } }, select: { id: true, platform: true, orderNumber: true, sourceUrl: true } });
  for (const r of rows) await d.requestCapture(userId, r);
  return rows.length;
}

/**
 * Read the merchant page for blocked orders whose item text is only a summary ("Electronics (1 items)", a cut-off title).
 * ids narrows it to the selected rows; without ids it takes every such blocked order. Only fills details: the order stays
 * blocked and ignoredByRule is untouched.
 */
export async function fetchBlockedItems(userId: number, ids?: number[], d: Deps = envDeps()): Promise<{ asked: number }> {
  const rows = await prisma.order.findMany({
    where: { userId, blockedAddressPattern: { not: null }, cancelled: false, ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, platform: true, orderNumber: true, sourceUrl: true, itemDescription: true },
    take: 200,
  });
  let asked = 0;
  for (const r of rows) {
    if (!isItemSummary(r.itemDescription)) continue;
    try { await d.requestCapture(userId, r); asked++; } catch (e) { console.error('[blocked-items] capture request failed:', String(e).slice(0, 120)); }
  }
  return { asked };
}

/** Timer pass: every order that is marked and not in step, or unmarked with an entry left to void. */
export async function retryAll(d: Deps = envDeps()): Promise<{ tried: number }> {
  const rows = await prisma.order.findMany({
    where: { OR: [{ darkbloomCategory: { not: null } }, { bloomEntryId: { not: null } }] },
    select: { id: true }, take: 200,
  });
  let tried = 0;
  for (const r of rows) {
    try { if ((await pushOrder(r.id, d)) !== 'synced') tried++; } catch (e) { console.error('[darkbloom] retry failed:', String(e).slice(0, 120)); }
  }
  return { tried };
}

export type Machine = { id: string; label: string };

/** The ledger's machines, read-only, for the hardware picker. Empty when the ledger is not set up or does not answer. */
export async function listMachines(d: Deps = envDeps()): Promise<Machine[]> {
  if (!d.url || !d.token) return [];
  for (const path of ['/v1/settings/machines', '/v1/settings']) {
    let r: { status: number; json: unknown };
    try { r = await call(d, path, 'GET'); } catch { return []; }
    if (r.status === 401) return [];
    if (r.status < 200 || r.status >= 300) continue;
    const j = r.json as { machines?: unknown } | unknown[] | null;
    const arr = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { machines?: unknown }).machines) ? (j as { machines: unknown[] }).machines : null;
    if (!arr) continue;
    return arr.flatMap((m): Machine[] => {
      const x = typeof m === 'string' ? { id: m } : (m as Record<string, unknown> | null);
      const id = x && typeof x.id === 'string' ? x.id : null;
      if (!id) return [];
      const label = [x!.display_name, x!.model].find(v => typeof v === 'string' && v) as string | undefined;
      return [{ id, label: label && label !== id ? `${label} (${id})` : id }];
    });
  }
  return [];
}
