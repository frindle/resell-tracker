// Server glue for the bank feed: connect, daily sync, file import, matching, accept/ignore.
// No journal postings come from bank rows in this phase; matchStatus is the only thing accept/ignore change.
import { prisma, getSetting, upsertSetting } from '../../db';
import { encryptRequired, decryptRequired, hasEncryptionKey, EncryptionKeyMissingError } from '../../secrets';
import { formatOrderDateIso } from '../../formatOrderDate.ts';
import { exclusive } from '../exclusive.ts';
import { booksEnabled } from '../service.ts';
import { claimSetupToken, fetchAccounts, SimpleFinError, dateWindows, type ClientOpts } from './simplefin.ts';
import { pruneRequestLog, budgetAllows, syncRange, MIN_MANUAL_SYNC_GAP_MS } from './window.ts';
import { planIngest } from './dedupe.ts';
import { parseOfx, looksLikeOfx, MAX_OFX_BYTES } from './ofx.ts';
import { suggestAll, type MatchTxn, type MatchAccount, type MatchOrder, type CardLastFours } from '../match.ts';
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
    return { accounts: stmts.length, inserted, updated };
  });
}

// ---- matching ----

async function runMatchingInner(userId: number) {
  const [txnRows, accts, orderRows, cards, matched] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { userId, matchStatus: { in: ['unmatched', 'suggested'] } } }),
    prisma.bankAccount.findMany({ where: { userId }, select: { id: true, last4: true, creditCardId: true } }),
    prisma.order.findMany({ where: { userId, cancelled: false, cardId: { not: null } } }),
    prisma.creditCard.findMany({ where: { userId }, include: { lastFours: true } }),
    prisma.bankTransaction.findMany({ where: { userId, matchStatus: 'matched', matchedOrderId: { not: null } }, select: { matchedOrderId: true } }),
  ]);
  const txns: MatchTxn[] = txnRows.map(t => ({ id: t.id, accountId: t.bankAccountId, postedDate: t.postedDate, amountCents: t.amountCents, description: t.description, matchStatus: t.matchStatus }));
  const orders: MatchOrder[] = orderRows.map(o => ({
    id: o.id, platform: o.platform, orderNumber: o.orderNumber, orderDate: formatOrderDateIso(o.orderDate), cardId: o.cardId,
    cost: o.cost, shippingCost: o.shippingCost, insuranceCost: o.insuranceCost, taxAmount: o.taxAmount, subtotalAmount: o.subtotalAmount, cancelled: o.cancelled,
  }));
  const lastFours: CardLastFours = new Map(cards.map(c => [c.id, new Set([...(c.last4 ? [c.last4] : []), ...c.lastFours.map(l => l.last4)])]));
  const taken = new Set(matched.map(m => m.matchedOrderId!).filter(x => x != null));
  const sug = suggestAll(txns, accts as MatchAccount[], orders, lastFours, taken);
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

export type MatchAction = { action: 'accept'; orderId?: number } | { action: 'ignore' } | { action: 'reset' };

/** Accept / ignore / reset one transaction. Only matchStatus and the match refs change. */
export async function applyMatchAction(userId: number, txnId: number, act: MatchAction) {
  return exclusive(userId, async () => {
    const t = await prisma.bankTransaction.findFirst({ where: { id: txnId, userId } });
    if (!t) throw new HttpError(404, 'not found');
    if (act.action === 'ignore') {
      await prisma.bankTransaction.update({ where: { id: t.id }, data: { matchStatus: 'ignored', matchedOrderId: null, matchedTxnId: null, suggestion: null } });
    } else if (act.action === 'reset') {
      // Undo a transfer on both sides.
      if (t.matchedTxnId != null) await prisma.bankTransaction.updateMany({ where: { id: t.matchedTxnId, userId, matchedTxnId: t.id }, data: { matchStatus: 'unmatched', matchedTxnId: null, suggestion: null } });
      await prisma.bankTransaction.update({ where: { id: t.id }, data: { matchStatus: 'unmatched', matchedOrderId: null, matchedTxnId: null, suggestion: null } });
    } else {
      let s: { kind?: string; txnId?: number; orderIds?: number[] } | null = null;
      try { s = t.suggestion ? JSON.parse(t.suggestion) : null; } catch { s = null; }
      if (t.matchStatus !== 'suggested' || !s) throw new HttpError(409, 'nothing suggested for this transaction');
      if (s.kind === 'transfer' && s.txnId != null) {
        const other = await prisma.bankTransaction.findFirst({ where: { id: s.txnId, userId } });
        if (!other || other.matchStatus === 'matched' || other.matchStatus === 'ignored') throw new HttpError(409, 'the other side is no longer open');
        await prisma.$transaction([
          prisma.bankTransaction.update({ where: { id: t.id }, data: { matchStatus: 'matched', matchedTxnId: other.id } }),
          prisma.bankTransaction.update({ where: { id: other.id }, data: { matchStatus: 'matched', matchedTxnId: t.id } }),
        ]);
      } else if (s.kind === 'order' && s.orderIds?.length) {
        const pick = act.orderId ?? (s.orderIds.length === 1 ? s.orderIds[0] : null);
        if (pick == null || !s.orderIds.includes(pick)) throw new HttpError(400, 'choose one of the suggested orders');
        const taken = await prisma.bankTransaction.findFirst({ where: { userId, matchStatus: 'matched', matchedOrderId: pick } });
        if (taken) throw new HttpError(409, 'that order is already matched to another transaction');
        await prisma.bankTransaction.update({ where: { id: t.id }, data: { matchStatus: 'matched', matchedOrderId: pick } });
      } else throw new HttpError(409, 'nothing suggested for this transaction');
    }
    return { ok: true };
  });
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
