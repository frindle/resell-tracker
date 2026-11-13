// DB glue for bank-row postings (source `bank:`) and for the reconcile grid and lock gate.
// Everything posts through applyDesired, so a second run changes nothing, an undone link reverses its entry,
// and a link in a locked month is redated by postEntry (redateForLocks).
import { prisma, getSetting } from '../../db';
import { formatOrderDateIso } from '../../formatOrderDate.ts';
import { PrismaStore } from '../prismaStore.ts';
import { applyDesired, type ReconcileResult } from '../reconcile.ts';
import { desiredBankEntries, accountRef, type BankAcctForBooks } from '../bankPostings.ts';
import { reconcileMonth, recOk, type RecResult, type RecPurchase, type RecTransferLeg } from '../bankReconcile.ts';
import { lastDayOfMonth } from '../dates.ts';
import { cents } from '../money.ts';

export async function bankPostingEnabled(userId: number): Promise<boolean> {
  return (await getSetting(userId, 'accounting.bankPosting'))?.value === 'true';
}

export async function reconcileBankRows(userId: number, goLive: string, now: Date): Promise<ReconcileResult> {
  const links = await prisma.bankMatch.findMany({ where: { userId } });
  const txnIds = [...new Set(links.map(l => l.txnId))];
  const partnerIds = links.filter(l => l.kind === 'transfer').map(l => l.refId);
  const [rows, accounts, orders] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { userId, id: { in: [...new Set([...txnIds, ...partnerIds])] } } }),
    prisma.bankAccount.findMany({ where: { userId }, select: { id: true, creditCardId: true, ledgerAccountId: true } }),
    prisma.order.findMany({ where: { userId, id: { in: [...new Set(links.filter(l => l.kind === 'order_charge').map(l => l.refId))] } }, select: { id: true, orderDate: true } }),
  ]);
  const desired = desiredBankEntries({
    rows: rows.map(r => ({ id: r.id, accountId: r.bankAccountId, postedDate: r.postedDate, amountCents: r.amountCents, pending: r.pending, description: r.description })),
    links: links.map(l => ({ txnId: l.txnId, kind: l.kind, refId: l.refId, amountCents: l.amountCents, note: l.note })),
    accounts,
    orderDays: new Map(orders.map(o => [o.id, formatOrderDateIso(o.orderDate)])),
    goLive,
  });
  return applyDesired(new PrismaStore(), userId, desired, { prefix: 'bank:' }, now);
}

/** order id -> sum of its `order_charge` link amounts (cents). */
export async function orderChargeTotals(userId: number): Promise<Map<number, number>> {
  const rows = await prisma.bankMatch.groupBy({ by: ['refId'], where: { userId, kind: 'order_charge' }, _sum: { amountCents: true } });
  return new Map(rows.map(r => [r.refId, r._sum.amountCents ?? 0]));
}

// ---- reconcile grid ----

export type RecAccount = RecResult & { accountName: string; kind: string; openRows: number };

export async function reconcileGrid(userId: number, month: string, goLive: string): Promise<RecAccount[]> {
  const monthEnd = lastDayOfMonth(month);
  const [accts, posting] = await Promise.all([
    prisma.bankAccount.findMany({ where: { userId }, include: { balances: true } }),
    bankPostingEnabled(userId),
  ]);
  const mapped = accts.filter(a => accountRef(a as BankAcctForBooks) != null);
  const out: RecAccount[] = [];
  for (const a of mapped) {
    const rows = await prisma.bankTransaction.findMany({ where: { userId, bankAccountId: a.id } });
    let ledgerId = a.ledgerAccountId;
    if (a.creditCardId != null) {
      const la = await prisma.ledgerAccount.findFirst({ where: { userId, systemKey: `card:${a.creditCardId}` }, select: { id: true } });
      ledgerId = la?.id ?? null;
    }
    const agg = ledgerId == null ? null : await prisma.journalLine.aggregate({ _sum: { amountCents: true }, where: { accountId: ledgerId, entry: { userId, date: { lte: monthEnd } } } });
    const booksCents = agg?._sum.amountCents ?? 0;

    const links = await prisma.bankMatch.findMany({ where: { userId, txnId: { in: rows.map(r => r.id) } } });
    const rowById = new Map(rows.map(r => [r.id, r]));
    let purchases: RecPurchase[] = [];
    if (a.creditCardId != null) {
      const orders = await prisma.order.findMany({ where: { userId, cardId: a.creditCardId, cancelled: false } });
      purchases = orders.map(o => ({ orderId: o.id, day: formatOrderDateIso(o.orderDate), purchaseCents: cents((o.cost ?? 0) + (o.shippingCost ?? 0) + (o.insuranceCost ?? 0)), charges: [] as RecPurchase['charges'] }))
        .filter(p => p.day >= goLive);
      const byOrder = new Map(purchases.map(p => [p.orderId, p]));
      for (const l of links) {
        if (l.kind !== 'order_charge') continue;
        const p = byOrder.get(l.refId); const r = rowById.get(l.txnId);
        if (p && r) p.charges.push({ postedDate: r.postedDate, cents: l.amountCents });
      }
    }
    const transfers: RecTransferLeg[] = [];
    if (posting) {
      for (const l of links) {
        if (l.kind !== 'transfer') continue;
        const mine = rowById.get(l.txnId);
        const other = await prisma.bankTransaction.findFirst({ where: { id: l.refId, userId }, select: { postedDate: true } });
        if (mine && other) transfers.push({ txnId: mine.id, postedDate: mine.postedDate, amountCents: mine.amountCents, partnerPostedDate: other.postedDate });
      }
    }
    const rec = reconcileMonth({
      accountId: a.id, month, monthEnd, goLive,
      statements: a.balances.map(b => ({ date: b.date, balanceCents: b.balanceCents, source: b.source })),
      rows: rows.map(r => ({ id: r.id, postedDate: r.postedDate, amountCents: r.amountCents, pending: r.pending, matchStatus: r.matchStatus, description: r.description })),
      booksCents, purchases, transfers,
    });
    const openRows = rec.items.filter(i => i.kind === 'open_row').length;
    out.push({ ...rec, accountName: a.name, kind: a.kind, openRows });
  }
  return out;
}

export type LockGate = { month: string; ok: boolean; problems: { accountId: number; accountName: string; status: string; unexplainedCents: number | null; openRows: number }[]; skipped?: string };

/**
 * Every mapped account must tie (or be fully explained) with no open rows in the month. Open shortfalls come with a later step.
 * With bank posting off the books hold no transfers or card payments, so no account could tie: the gate is skipped.
 */
export async function lockGate(userId: number, month: string, goLive: string): Promise<LockGate> {
  if (!(await bankPostingEnabled(userId))) return { month, ok: true, problems: [], skipped: 'bank posting is off' };
  const grid = await reconcileGrid(userId, month, goLive);
  const problems = grid
    .filter(r => !recOk(r.status) || r.openRows > 0)
    .map(r => ({ accountId: r.accountId, accountName: r.accountName, status: r.status, unexplainedCents: r.unexplainedCents, openRows: r.openRows }));
  return { month, ok: problems.length === 0, problems };
}

export type LockResult = { ok: true; forced: boolean } | { ok: false; gate: LockGate };

/**
 * Lock a month. A month that passes the gate locks normally. One that does not is refused with the gate unless `force`
 * is true and `reason` is non-empty; then it locks and an audit row ('lock_anyway') records the reason and what was open.
 */
export async function lockMonth(userId: number, month: string, goLive: string, opts: { force?: boolean; reason?: string } = {}): Promise<LockResult> {
  const gate = await lockGate(userId, month, goLive);
  const why = (opts.reason ?? '').trim();
  const upsert = prisma.periodLock.upsert({ where: { userId_month: { userId, month } }, create: { userId, month }, update: {} });
  if (gate.ok) {
    await prisma.$transaction([upsert, prisma.auditLog.create({ data: { userId, actor: `user:${userId}`, action: 'lock', entity: 'PeriodLock', entityId: month } })]);
    return { ok: true, forced: false };
  }
  if (opts.force !== true || !why) return { ok: false, gate };
  await prisma.$transaction([
    upsert,
    prisma.auditLog.create({ data: { userId, actor: `user:${userId}`, action: 'lock_anyway', entity: 'PeriodLock', entityId: month, after: JSON.stringify({ reason: why, problems: gate.problems }) } }),
  ]);
  return { ok: true, forced: true };
}
