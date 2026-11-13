// Server-side glue: settings, chart seeding, loading rows for the pure layers,
// and the entry points routes and the scheduler call.
import { clampedReturns } from './returnLines.ts';
import { prisma, getSetting, upsertSetting } from '../db';
import { PrismaStore } from './prismaStore.ts';
import { CHART } from './chart.ts';
import { laDay } from './dates.ts';
import { type ReconcileResult, reconcileOpening, reconcileOrders } from './reconcile.ts';
import { type CostForBooks, reconcileCosts } from './costs.ts';
import { type OrderForBooks } from './orderPostings.ts';
import { type OpeningInput, EMPTY_OPENING } from './opening.ts';
import { type TallyRows, syncTally } from './tally.ts';
import type { BooksStore } from './types.ts';
import { exclusive } from './exclusive.ts';
import { bankPostingEnabled, reconcileBankRows, orderChargeTotals } from './bank/posting.ts';

export const DEFAULT_GO_LIVE = '2027-01-01';

export async function booksEnabled(userId: number | null): Promise<boolean> {
  if (userId == null) return false;
  return (await getSetting(userId, 'accounting.enabled'))?.value === 'true';
}

export async function getGoLive(userId: number): Promise<string> {
  const v = (await getSetting(userId, 'accounting.goLive'))?.value;
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_GO_LIVE;
}

export async function setBooksEnabled(userId: number, on: boolean) {
  await upsertSetting(userId, 'accounting.enabled', on ? 'true' : 'false');
  if (on) await seedChart(new PrismaStore(), userId);
}

/** Idempotent: creates the seeded chart plus one account per card / loan. Buyer accounts appear on first posting. */
export async function seedChart(store: BooksStore, userId: number): Promise<void> {
  // One listing, then only the missing accounts: a run no longer costs a query per chart account.
  const have = new Set((await store.listAccounts(userId)).map(a => a.systemKey));
  for (const c of CHART) if (!have.has(c.key)) await store.resolveAccount(userId, c.key);
  const [cards, loans] = await Promise.all([
    prisma.creditCard.findMany({ where: { userId }, select: { id: true } }),
    prisma.loan.findMany({ where: { userId }, select: { id: true } }),
  ]);
  for (const c of cards) if (!have.has(`card:${c.id}`)) await store.resolveAccount(userId, `card:${c.id}`);
  for (const l of loans) if (!have.has(`loan:${l.id}`)) await store.resolveAccount(userId, `loan:${l.id}`);
}

export async function loadOrders(userId: number): Promise<OrderForBooks[]> {
  const rows = await prisma.order.findMany({
    where: { userId },
    include: { giftCards: true, returns: true, commitmentLinks: { select: { id: true, quantity: true } }, bfmrLinks: { include: { reservation: { select: { datePaid: true } } } } },
  });
  // With bank posting on, the card charges linked to an order fill its unknown tax (and the sale's COGS follows).
  const charges = (await bankPostingEnabled(userId)) ? await orderChargeTotals(userId) : null;
  return rows.map(o => ({
    taxAmount: o.taxAmount, subtotalAmount: o.subtotalAmount, chargeCents: charges?.get(o.id) ?? null,
    id: o.id, platform: o.platform, orderDate: o.orderDate, cost: o.cost, shippingCost: o.shippingCost,
    insuranceCost: o.insuranceCost, returnedCost: o.returnedCost, salePrice: o.salePrice, salePriceSynced: o.salePriceSynced,
    buyerId: o.buyerId, cardId: o.cardId, cashbackAmount: o.cashbackAmount, portalCashback: o.portalCashback,
    amexOfferDollars: o.amexOfferDollars, bgPaidAmount: o.bgPaidAmount, bfmrStatus: o.bfmrStatus, lost: o.lost,
    cancelled: o.cancelled, ignoredByRule: o.ignoredByRule,
    giftCards: o.giftCards.map(g => ({ ccSubmittedAt: g.ccSubmittedAt, ccPaymentStatus: g.ccPaymentStatus, ccPaymentDueAt: g.ccPaymentDueAt })),
    bfmrPaidAt: o.bfmrLinks.map(l => l.reservation?.datePaid).filter((x): x is Date => x != null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
    returns: clampedReturns(o.returns, o.bfmrLinks, o.commitmentLinks),
  }));
}

export async function loadCosts(userId: number): Promise<CostForBooks[]> {
  const rows = await prisma.costEntry.findMany({ where: { userId } });
  return rows.map(c => ({
    id: c.id, business: c.business, date: c.date, amountCents: c.amountCents, category: c.category, vendor: c.vendor,
    purpose: c.purpose, businessPct: c.businessPct, paidFromAccountId: c.paidFromAccountId, voidedAt: c.voidedAt,
  }));
}

export type ReconcileSummary = { orders: ReconcileResult; costs: ReconcileResult; bank: ReconcileResult | null };

/** One reconcile pass. The caller holds the per-user lock. Bank rows post only when accounting.bankPosting is on. */
export async function reconcileInner(userId: number, now: Date): Promise<ReconcileSummary> {
  const store = new PrismaStore();
  await seedChart(store, userId);
  const goLive = await getGoLive(userId);
  const orders = await reconcileOrders(store, userId, await loadOrders(userId), { goLive, now });
  const costs = await reconcileCosts(store, userId, await loadCosts(userId), now);
  const bank = (await bankPostingEnabled(userId)) ? await reconcileBankRows(userId, goLive, now) : null;
  return { orders, costs, bank };
}

export function runReconcile(userId: number, now = new Date()): Promise<ReconcileSummary> {
  return exclusive(userId, () => reconcileInner(userId, now));
}

export async function readOpeningInput(userId: number): Promise<OpeningInput> {
  const v = (await getSetting(userId, 'accounting.openingInput'))?.value;
  if (!v) return EMPTY_OPENING;
  try { return { ...EMPTY_OPENING, ...JSON.parse(v) }; } catch { return EMPTY_OPENING; }
}

export type OpeningAudit = { userId: number; actor: string; action: string; entity: string; entityId: string; before: string; after: string };

/** The audit row and the saved input are written in one transaction, inside the per-user lock. */
export function applyOpening(userId: number, input: OpeningInput, now = new Date(), audit?: OpeningAudit) {
  return exclusive(userId, async () => {
    const store = new PrismaStore();
    await seedChart(store, userId);
    const goLive = await getGoLive(userId);
    const r = await reconcileOpening(store, userId, await loadOrders(userId), input, { goLive, now });
    await prisma.$transaction(async tx => {
      const existing = await tx.setting.findFirst({ where: { userId, key: 'accounting.openingInput' } });
      if (existing) await tx.setting.update({ where: { id: existing.id }, data: { value: JSON.stringify(input) } });
      else await tx.setting.create({ data: { userId, key: 'accounting.openingInput', value: JSON.stringify(input) } });
      if (audit) await tx.auditLog.create({ data: audit });
    });
    return r;
  });
}

// Fire-and-forget after order writes. Debounced per user so a burst of edits is one run.
const timers = new Map<number, ReturnType<typeof setTimeout>>();
export function scheduleBooksReconcile(userId: number | null | undefined) {
  if (userId == null) return;
  const t = timers.get(userId);
  if (t) clearTimeout(t);
  timers.set(userId, setTimeout(() => {
    timers.delete(userId);
    booksEnabled(userId)
      .then(on => (on ? runReconcile(userId) : undefined))
      .catch(err => console.error('[books] reconcile failed:', err));
  }, 5000));
}

export async function reconcileAllUsers(): Promise<void> {
  const rows = await prisma.setting.findMany({ where: { key: 'accounting.enabled', value: 'true' }, select: { userId: true } });
  for (const r of rows) {
    if (r.userId == null) continue;
    try { await runReconcile(r.userId); } catch (e) { console.error('[books] reconcile failed for user', r.userId, e); }
  }
}

const prismaTallyRows: TallyRows = {
  async get(userId, month) {
    const r = await prisma.darkbloomTally.findUnique({ where: { userId_month: { userId, month } } });
    return r ? { month: r.month, hash: r.hash, postedEntryId: r.postedEntryId } : null;
  },
  async save(userId, row) {
    await prisma.darkbloomTally.upsert({
      where: { userId_month: { userId, month: row.month } },
      create: { userId, month: row.month, hash: row.hash, payload: row.payload, postedEntryId: row.postedEntryId },
      update: { hash: row.hash, payload: row.payload, postedEntryId: row.postedEntryId, fetchedAt: new Date() },
    });
  },
};

export function runTallySync(userId: number, now = new Date()) {
  return exclusive(userId, async () => {
    const store = new PrismaStore();
    await seedChart(store, userId);
    return syncTally(store, prismaTallyRows, userId, { baseUrl: process.env.BLOOM_LEDGER_URL, goLive: await getGoLive(userId), now });
  });
}

export async function tallyAllUsers(): Promise<void> {
  if (!process.env.BLOOM_LEDGER_URL) return;
  const rows = await prisma.setting.findMany({ where: { key: 'accounting.enabled', value: 'true' }, select: { userId: true } });
  for (const r of rows) {
    if (r.userId == null) continue;
    try { await runTallySync(r.userId); } catch (e) { console.error('[books] tally sync failed for user', r.userId, e); }
  }
}

export const todayLA = () => laDay(new Date());
