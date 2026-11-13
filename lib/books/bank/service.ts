// Server glue for the bank feed: connect, daily sync, file import, matching, and links (BankMatch).
// Accept / ignore / personal / reset write links; with accounting.bankPosting on, the books are reconciled right after.
import { prisma, getSetting, upsertSetting } from '../../db';
import { encryptRequired, decryptRequired, hasEncryptionKey, EncryptionKeyMissingError } from '../../secrets';
import { formatOrderDateIso } from '../../formatOrderDate.ts';
import { exclusive } from '../exclusive.ts';
import { booksEnabled, reconcileInner } from '../service.ts';
import { bankPostingEnabled } from './posting.ts';
import { PrismaStore } from '../prismaStore.ts';
import { laDay } from '../dates.ts';
import { cents } from '../money.ts';
import { isMapped } from '../bankPostings.ts';
import { claimSetupToken, fetchAccounts, SimpleFinError, dateWindows, type ClientOpts } from './simplefin.ts';
import { pruneRequestLog, budgetAllows, syncRange, MIN_MANUAL_SYNC_GAP_MS } from './window.ts';
import { planIngest } from './dedupe.ts';
import { parseOfx, looksLikeOfx, MAX_OFX_BYTES } from './ofx.ts';
import { suggestAll, expectedChargeCents, allocateCharge, type MatchTxn, type MatchAccount, type MatchOrder, type MatchReturn, type CardLastFours } from '../match.ts';
import type { BankAcctIn, BankTxnIn, FeedError } from './types.ts';

const REQ_LOG_KEY = 'bank.simplefin.requests';

async function readLog(userId: number): Promise<number[]> {
  try { const v = JSON.parse((await getSetting(userId, REQ_LOG_KEY))?.value ?? '[]'); return Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'number') : []; } catch { return []; }
}

export { EncryptionKeyMissingError, hasEncryptionKey };

// ---- ingest ----

type Source = 'simplefin' | 'ofx' | 'csv';

async function ingestAccount(userId: number, connectionId: number | null, provider: string, source: Source, a: BankAcctIn, window: { windowStart: string; windowEnd: string } | null, forceAccountId?: number) {
  let acct = forceAccountId != null
    ? await prisma.bankAccount.findFirst({ where: { id: forceAccountId, userId } })
    : await prisma.bankAccount.findFirst({ where: { userId, provider, providerAccountId: a.providerAccountId } });
  if (forceAccountId != null && !acct) throw new Error('unknown account');
  if (!acct) {
    acct = await prisma.bankAccount.create({
      data: {
        userId, connectionId, provider, providerAccountId: a.providerAccountId, name: a.name, orgName: a.orgName, currency: a.currency,
        kind: a.kind, last4: a.last4, balanceCents: a.balanceCents, balanceDate: a.balanceDate,
      },
    });
  } else {
    // Never overwrite what the user set (links, last4 they corrected); refresh what the bank owns.
    await prisma.bankAccount.update({
      where: { id: acct.id },
      data: {
        ...(connectionId != null ? { connectionId } : {}),
        ...(source === 'simplefin' ? { name: a.name, orgName: a.orgName, currency: a.currency } : {}),
        ...(acct.last4 == null && a.last4 ? { last4: a.last4 } : {}),
        ...(a.balanceCents != null && (a.balanceDate ?? '') >= (acct.balanceDate ?? '') ? { balanceCents: a.balanceCents, balanceDate: a.balanceDate } : {}),
      },
    });
  }
  if (a.balanceCents != null && source !== 'csv') {
    const date = a.balanceDate ?? laDay(new Date());
    await prisma.statementBalance.upsert({
      where: { bankAccountId_date_source: { bankAccountId: acct.id, date, source } },
      create: { bankAccountId: acct.id, date, balanceCents: a.balanceCents, source },
      update: { balanceCents: a.balanceCents },
    });
  }
  const existing = await prisma.bankTransaction.findMany({
    where: { bankAccountId: acct.id },
    select: { id: true, providerTxnId: true, postedDate: true, pending: true, matchStatus: true, amountCents: true, description: true, transactedDate: true },
  });
  const plan = planIngest(existing, a.transactions, window);
  const data = (r: BankTxnIn) => ({
    postedDate: r.postedDate, transactedDate: r.transactedDate, amountCents: r.amountCents, description: r.description,
    payee: r.payee, memo: r.memo, pending: r.pending,
  });
  const ops = [
    ...plan.insert.map(r => prisma.bankTransaction.create({ data: { userId, bankAccountId: acct!.id, providerTxnId: r.providerTxnId, source, ...data(r) } })),
    // Updates keep matchStatus and the match refs, so a pending row that posts stays matched.
    ...plan.update.map(u => prisma.bankTransaction.update({ where: { id: u.id }, data: data(u.row) })),
    ...(plan.deleteIds.length ? [prisma.bankTransaction.deleteMany({ where: { id: { in: plan.deleteIds } } })] : []),
  ];
  if (ops.length) await prisma.$transaction(ops);
  return { accountId: acct.id, inserted: plan.insert.length, updated: plan.update.length, removed: plan.deleteIds.length };
}

// ---- connect / sync ----

export async function connectSimpleFin(userId: number, setupToken: string, opts: ClientOpts = {}) {
  // Check the key BEFORE claiming: a Setup Token can only be claimed once, so a failure after the claim would lose it.
  if (!hasEncryptionKey()) throw new EncryptionKeyMissingError();
  const accessUrl = await claimSetupToken(setupToken, opts);
  const enc = encryptRequired(accessUrl);
  const existing = await prisma.bankConnection.findFirst({ where: { userId, provider: 'simplefin' } });
  const conn = existing
    ? await prisma.bankConnection.update({ where: { id: existing.id }, data: { accessUrlEnc: enc, lastError: null, lastErrors: null } })
    : await prisma.bankConnection.create({ data: { userId, provider: 'simplefin', accessUrlEnc: enc } });
  return conn.id;
}

export async function disconnect(userId: number) {
  await prisma.bankConnection.deleteMany({ where: { userId, provider: 'simplefin' } }); // accounts and rows stay (connectionId -> null)
}

export type SyncSummary = { inserted: number; updated: number; removed: number; accounts: number; errors: FeedError[]; requests: number };

export function syncSimpleFin(userId: number, opts: ClientOpts & { now?: Date; manual?: boolean } = {}): Promise<SyncSummary> {
  return exclusive(userId, async () => {
    const now = opts.now ?? new Date();
    const conn = await prisma.bankConnection.findFirst({ where: { userId, provider: 'simplefin' } });
    if (!conn) throw new Error('no SimpleFIN connection');
    if (opts.manual && conn.lastSyncAt && now.getTime() - conn.lastSyncAt.getTime() < MIN_MANUAL_SYNC_GAP_MS) {
      throw new Error('synced a moment ago; SimpleFIN allows about 24 requests a day, try again in a few minutes');
    }
    const range = syncRange(conn.lastSyncAt, now);
    const nWindows = dateWindows(range.startDay, range.endDay).length;
    const log = pruneRequestLog(await readLog(userId), now.getTime());
    if (!budgetAllows(log, now.getTime(), nWindows)) throw new Error('SimpleFIN daily request budget (24) used up; try again later');
    let result;
    try {
      const accessUrl = decryptRequired(conn.accessUrlEnc);
      result = await fetchAccounts(accessUrl, range, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'sync failed';
      await prisma.bankConnection.update({ where: { id: conn.id }, data: { lastError: msg.slice(0, 500) } });
      if (e instanceof SimpleFinError || e instanceof EncryptionKeyMissingError) throw e;
      throw new Error(msg);
    }
    await upsertSetting(userId, REQ_LOG_KEY, JSON.stringify([...log, ...Array(result.requests).fill(now.getTime())]));
    const sum: SyncSummary = { inserted: 0, updated: 0, removed: 0, accounts: result.accounts.length, errors: result.errors, requests: result.requests };
    for (const a of result.accounts) {
      const r = await ingestAccount(userId, conn.id, 'simplefin', 'simplefin', a, { windowStart: range.startDay, windowEnd: range.endDay });
      sum.inserted += r.inserted; sum.updated += r.updated; sum.removed += r.removed;
    }
    await prisma.bankConnection.update({
      where: { id: conn.id },
      data: { lastSyncAt: now, lastError: null, lastErrors: result.errors.length ? JSON.stringify(result.errors) : null },
    });
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return sum;
  });
}

export async function syncAllBankUsers(): Promise<void> {
  const rows = await prisma.bankConnection.findMany({ where: { provider: 'simplefin' }, select: { userId: true } });
  for (const r of rows) {
    try {
      if (!(await booksEnabled(r.userId))) continue;
      await syncSimpleFin(r.userId);
    } catch (e) { console.error('[books] bank sync failed for user', r.userId, e instanceof Error ? e.message : 'error'); }
  }
}

// ---- OFX / QFX upload ----

export async function importOfx(userId: number, bytes: Uint8Array, bankAccountId?: number) {
  if (bytes.length > MAX_OFX_BYTES) throw new Error(`file is larger than ${MAX_OFX_BYTES / 1024 / 1024} MB`);
  const text = Buffer.from(bytes).toString('utf8');
  if (!looksLikeOfx(text)) throw new Error('that does not look like an OFX or QFX file');
  const stmts = parseOfx(text);
  if (bankAccountId != null && stmts.length > 1) throw new Error('this file holds several accounts; import it without choosing one');
  return exclusive(userId, async () => {
    let inserted = 0, updated = 0;
    for (const s of stmts) {
      const a: BankAcctIn = {
        providerAccountId: s.providerAccountId, name: `${s.org ?? 'Imported'} ${s.kind === 'credit' ? 'card' : 'account'}${s.last4 ? ` ${s.last4}` : ''}`,
        orgName: s.org, currency: s.currency, kind: s.kind, last4: s.last4, balanceCents: s.balanceCents, balanceDate: s.balanceDate, transactions: s.transactions,
      };
      // Files are partial views: never delete anything (window null), and re-uploading changes nothing.
      const r = await ingestAccount(userId, null, 'ofx', 'ofx', a, null, bankAccountId);
      inserted += r.inserted; updated += r.updated;
    }
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return { accounts: stmts.length, inserted, updated };
  });
}

// ---- matching ----

async function runMatchingInner(userId: number) {
  const [txnRows, accts, orderRows, cards, chargeLinks, refundLinks, returnRows] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { userId, matchStatus: { in: ['unmatched', 'suggested'] } } }),
    prisma.bankAccount.findMany({ where: { userId }, select: { id: true, last4: true, creditCardId: true } }),
    prisma.order.findMany({ where: { userId, cancelled: false, cardId: { not: null } } }),
    prisma.creditCard.findMany({ where: { userId }, include: { lastFours: true } }),
    prisma.bankMatch.findMany({ where: { userId, kind: 'order_charge' }, select: { refId: true } }),
    prisma.bankMatch.findMany({ where: { userId, kind: 'order_refund' }, select: { refId: true } }),
    prisma.orderReturn.findMany({ where: { status: 'refunded', order: { userId, cardId: { not: null } } }, include: { order: { select: { cardId: true } } } }),
  ]);
  const txns: MatchTxn[] = txnRows.map(t => ({ id: t.id, accountId: t.bankAccountId, postedDate: t.postedDate, amountCents: t.amountCents, description: t.description, matchStatus: t.matchStatus }));
  const orders: MatchOrder[] = orderRows.map(o => ({
    id: o.id, platform: o.platform, orderNumber: o.orderNumber, orderDate: formatOrderDateIso(o.orderDate), cardId: o.cardId,
    cost: o.cost, shippingCost: o.shippingCost, insuranceCost: o.insuranceCost, taxAmount: o.taxAmount, subtotalAmount: o.subtotalAmount, cancelled: o.cancelled,
  }));
  const lastFours: CardLastFours = new Map(cards.map(c => [c.id, new Set([...(c.last4 ? [c.last4] : []), ...c.lastFours.map(l => l.last4)])]));
  const taken = new Set(chargeLinks.map(m => m.refId));
  const takenReturnIds = new Set(refundLinks.map(m => m.refId));
  const events = await new PrismaStore().eventDates([...new Set(returnRows.map(r => r.orderId))]);
  const returns: MatchReturn[] = returnRows.map(r => ({
    id: r.id, orderId: r.orderId, cardId: r.order.cardId, refundCents: cents(r.refundAmount ?? 0),
    refundedDate: events.get(r.orderId)?.get(`refunded:${r.id}`) ?? (r.refundedAt ? laDay(r.refundedAt) : null),
  }));
  const sug = suggestAll(txns, accts as MatchAccount[], orders, lastFours, taken, { returns, takenReturnIds });
  const ops = [];
  for (const t of txnRows) {
    const s = sug.get(t.id);
    const json = s ? JSON.stringify(s) : null;
    const status = s ? 'suggested' : 'unmatched';
    if (t.matchStatus !== status || t.suggestion !== json) ops.push(prisma.bankTransaction.update({ where: { id: t.id }, data: { matchStatus: status, suggestion: json } }));
  }
  if (ops.length) await prisma.$transaction(ops);
  return { suggested: sug.size };
}

export const runMatching = (userId: number) => exclusive(userId, () => runMatchingInner(userId));

export type MatchAction =
  | { action: 'accept'; orderId?: number; orderIds?: number[]; txnIds?: number[]; returnId?: number }
  | { action: 'ignore'; duplicate?: boolean }
  | { action: 'personal' }
  | { action: 'reset' };

type Link = { txnId: number; kind: string; refId: number; amountCents: number };
const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();

/** Re-run the reconcile (orders, costs, bank rows) when bank posting is on. Inside the caller's lock. */
async function postAfterChange(userId: number) {
  if (await bankPostingEnabled(userId)) await reconcileInner(userId, new Date());
}

/**
 * Accept / ignore / personal / reset one transaction. Writes BankMatch links (never the old matchedOrderId /
 * matchedTxnId columns). With accounting.bankPosting on, the books are reconciled right after, in the same lock.
 */
export async function applyMatchAction(userId: number, txnId: number, act: MatchAction) {
  return exclusive(userId, async () => {
    const t = await prisma.bankTransaction.findFirst({ where: { id: txnId, userId }, include: { account: { select: { id: true, creditCardId: true, ledgerAccountId: true } } } });
    if (!t) throw new HttpError(404, 'not found');
    const abs = Math.abs(t.amountCents);
    const open = (x: { matchStatus: string }) => x.matchStatus === 'unmatched' || x.matchStatus === 'suggested';
    if (act.action === 'reset') {
      await resetLinks(userId, t.id);
    } else if (act.action === 'ignore') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      if (isMapped(t.account) && !act.duplicate) {
        throw new HttpError(409, 'this account is in your books, so ignoring a row would hide real money; use Personal, link it, or mark it a duplicate');
      }
      await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'ignore', refId: 0, amountCents: abs }], 'ignored', act.action === 'ignore' && act.duplicate ? 'duplicate' : undefined);
    } else if (act.action === 'personal') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'personal', refId: 0, amountCents: abs }], 'matched');
    } else {
      let s: { kind?: string; txnId?: number; orderIds?: number[]; orderId?: number; subsets?: number[][]; returns?: { returnId: number; orderId: number }[] } | null = null;
      try { s = t.suggestion ? JSON.parse(t.suggestion) : null; } catch { s = null; }
      if (t.matchStatus !== 'suggested' || !s) throw new HttpError(409, 'nothing suggested for this transaction');
      if ((s.kind === 'transfer' || s.kind === 'pair') && s.txnId != null) {
        const other = await prisma.bankTransaction.findFirst({ where: { id: s.txnId, userId } });
        if (!other || !open(other)) throw new HttpError(409, 'the other side is no longer open');
        if (Math.abs(other.amountCents) !== abs || Math.sign(other.amountCents) === Math.sign(t.amountCents)) throw new HttpError(400, 'the two sides must be equal and opposite');
        const kind = s.kind === 'transfer' ? 'transfer' : 'reversal_pair';
        await writeLinks(t.id, userId, [
          { txnId: t.id, kind, refId: other.id, amountCents: abs },
          { txnId: other.id, kind, refId: t.id, amountCents: abs },
        ], 'matched');
      } else if (s.kind === 'order' && s.orderIds?.length) {
        const pick = act.action === 'accept' ? (act.orderId ?? (s.orderIds.length === 1 ? s.orderIds[0] : null)) : null;
        if (pick == null || !s.orderIds.includes(pick)) throw new HttpError(400, 'choose one of the suggested orders');
        await assertOrdersFree(userId, [pick]);
        await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'order_charge', refId: pick, amountCents: abs }], 'matched');
      } else if (s.kind === 'split' && s.orderId != null && s.subsets?.length) {
        const pick = act.action === 'accept' && act.txnIds ? act.txnIds : s.subsets.length === 1 ? s.subsets[0] : null;
        if (!pick || !s.subsets.some(x => sameSet(x, pick))) throw new HttpError(400, 'choose one of the suggested sets of charges');
        await assertOrdersFree(userId, [s.orderId]);
        const rows = await prisma.bankTransaction.findMany({ where: { userId, id: { in: pick } } });
        if (rows.length !== pick.length || !rows.every(open)) throw new HttpError(409, 'one of those charges is no longer open');
        for (const r of rows) await writeLinks(r.id, userId, [{ txnId: r.id, kind: 'order_charge', refId: s.orderId, amountCents: Math.abs(r.amountCents) }], 'matched');
      } else if (s.kind === 'multi' && s.subsets?.length) {
        const pick = act.action === 'accept' && act.orderIds ? act.orderIds : s.subsets.length === 1 ? s.subsets[0] : null;
        if (!pick || !s.subsets.some(x => sameSet(x, pick))) throw new HttpError(400, 'choose one of the suggested sets of orders');
        await assertOrdersFree(userId, pick);
        const os = await prisma.order.findMany({ where: { userId, id: { in: pick } } });
        const bounds = os.map(o => {
          const e = expectedChargeCents({ id: o.id, platform: o.platform, orderNumber: o.orderNumber, orderDate: '', cardId: o.cardId, cost: o.cost, shippingCost: o.shippingCost, insuranceCost: o.insuranceCost, taxAmount: o.taxAmount, subtotalAmount: o.subtotalAmount, cancelled: o.cancelled });
          return { id: o.id, min: e.min, max: e.max };
        });
        const alloc = allocateCharge(abs, bounds);
        const sum = [...alloc.values()].reduce((x, y) => x + y, 0);
        if (sum !== abs) { // the charge is outside the orders' tax range: the first order absorbs the difference
          const first = bounds[0].id;
          alloc.set(first, alloc.get(first)! + (abs - sum));
        }
        if ([...alloc.values()].some(v => v <= 0)) throw new HttpError(400, 'the charge is too small for those orders');
        await writeLinks(t.id, userId, [...alloc.entries()].map(([id, c]) => ({ txnId: t.id, kind: 'order_charge', refId: id, amountCents: c })), 'matched');
      } else if (s.kind === 'refund' && s.returns?.length) {
        const pick = act.action === 'accept' ? (act.returnId ?? (s.returns.length === 1 ? s.returns[0].returnId : null)) : null;
        if (pick == null || !s.returns.some(r => r.returnId === pick)) throw new HttpError(400, 'choose one of the suggested returns');
        if (await prisma.bankMatch.findFirst({ where: { userId, kind: 'order_refund', refId: pick } })) throw new HttpError(409, 'that return already has a refund linked');
        await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'order_refund', refId: pick, amountCents: abs }], 'matched');
      } else throw new HttpError(409, 'nothing suggested for this transaction');
    }
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return { ok: true };
  });
}

async function assertOrdersFree(userId: number, orderIds: number[]) {
  const taken = await prisma.bankMatch.findFirst({ where: { userId, kind: 'order_charge', refId: { in: orderIds } } });
  if (taken) throw new HttpError(409, 'that order is already linked to a charge');
}

/** Replace a row's links in one transaction and keep its status in step. Link sums must equal the row's amount. */
export async function writeLinks(txnId: number, userId: number, links: Link[], status: 'matched' | 'ignored', note?: string) {
  const byTxn = new Map<number, Link[]>();
  for (const l of links) (byTxn.get(l.txnId) ?? byTxn.set(l.txnId, []).get(l.txnId)!).push(l);
  const rows = await prisma.bankTransaction.findMany({ where: { userId, id: { in: [...byTxn.keys()] } }, select: { id: true, amountCents: true } });
  for (const r of rows) {
    const sum = byTxn.get(r.id)!.reduce((x, l) => x + l.amountCents, 0);
    if (sum !== Math.abs(r.amountCents)) throw new HttpError(400, `the links add up to ${sum} cents but the transaction is ${Math.abs(r.amountCents)}`);
  }
  void txnId;
  await prisma.$transaction([
    ...links.map(l => prisma.bankMatch.create({ data: { userId, txnId: l.txnId, kind: l.kind, refId: l.refId, amountCents: l.amountCents, note: note ?? null, matchedBy: 'user' } })),
    ...rows.map(r => prisma.bankTransaction.update({ where: { id: r.id }, data: { matchStatus: status, suggestion: null } })),
  ]);
}

/** Undo: delete the row's links and those of its partner (transfer / pair) or sibling charges (split), back to unmatched. */
async function resetLinks(userId: number, txnId: number) {
  const mine = await prisma.bankMatch.findMany({ where: { userId, txnId } });
  const affected = new Set<number>([txnId]);
  for (const l of mine) {
    if (l.kind === 'transfer' || l.kind === 'reversal_pair') affected.add(l.refId);
    if (l.kind === 'order_charge') {
      const sib = await prisma.bankMatch.findMany({ where: { userId, kind: 'order_charge', refId: l.refId }, select: { txnId: true } });
      for (const x of sib) affected.add(x.txnId);
    }
  }
  const ids = [...affected];
  await prisma.$transaction([
    prisma.bankMatch.deleteMany({ where: { userId, txnId: { in: ids } } }),
    prisma.bankTransaction.updateMany({ where: { userId, id: { in: ids } }, data: { matchStatus: 'unmatched', suggestion: null, matchedOrderId: null, matchedTxnId: null } }),
  ]);
}

// ---- statement balances ----

export async function setManualBalance(userId: number, accountId: number, date: string, balanceCents: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  if (!Number.isInteger(balanceCents)) throw new HttpError(400, 'balance must be whole cents');
  const acct = await prisma.bankAccount.findFirst({ where: { id: accountId, userId } });
  if (!acct) throw new HttpError(404, 'not found');
  await prisma.statementBalance.upsert({
    where: { bankAccountId_date_source: { bankAccountId: accountId, date, source: 'manual' } },
    create: { bankAccountId: accountId, date, balanceCents, source: 'manual' },
    update: { balanceCents },
  });
  return { ok: true };
}

export async function deleteManualBalance(userId: number, accountId: number, date: string) {
  const acct = await prisma.bankAccount.findFirst({ where: { id: accountId, userId } });
  if (!acct) throw new HttpError(404, 'not found');
  await prisma.statementBalance.deleteMany({ where: { bankAccountId: accountId, date, source: 'manual' } });
  return { ok: true };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** What the UI shows about the connection. Never includes the Access URL. */
export async function connectionStatus(userId: number) {
  const c = await prisma.bankConnection.findFirst({ where: { userId, provider: 'simplefin' }, select: { id: true, lastSyncAt: true, lastError: true, lastErrors: true } });
  let errors: FeedError[] = [];
  try { errors = c?.lastErrors ? JSON.parse(c.lastErrors) : []; } catch { errors = []; }
  return {
    encryptionConfigured: hasEncryptionKey(),
    connection: c ? { id: c.id, lastSyncAt: c.lastSyncAt, lastError: c.lastError, errors } : null,
  };
}
