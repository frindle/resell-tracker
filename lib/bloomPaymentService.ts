import { prisma } from './db';
import { exclusive } from './books/exclusive';
import { getGoLive } from './books/service';
import { laDay } from './books/dates';
import { isOwner } from './owner';
import {
  addManualRequest, parseWithdrawals, paymentRows, runPayments,
  type Deposit, type LedgerWithdrawal, type ManualInput, type PaymentRequest, type PaymentRunResult, type PaymentStore,
} from './bloomPayment';

const toRequest = (r: { id: number; month: string; source: string; ledgerKey: string | null; requestedAt: string; requestedCents: number; sentDate: string | null; sentCents: number | null; sentTxnId: number | null }): PaymentRequest =>
  ({ ...r, source: r.source === 'manual' ? 'manual' : 'detected' });

const store: PaymentStore = {
  async invoices(userId) {
    const rows = await prisma.bloomInvoice.findMany({ where: { userId }, orderBy: { month: 'asc' }, select: { month: true, hash: true, grossCents: true, feesCents: true, payload: true } });
    return rows;
  },
  async copies(userId) {
    return prisma.bloomInvoiceCopy.findMany({ where: { userId }, orderBy: [{ month: 'asc' }, { copy: 'asc' }], select: { month: true, copy: true, payload: true } });
  },
  async addCopy(userId, row) {
    try {
      await prisma.bloomInvoiceCopy.create({ data: { userId, month: row.month, copy: row.copy, hash: row.hash, dueCents: row.dueCents, payload: row.payload } });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false; // already written: copies are never replaced
      throw e;
    }
  },
  async requests(userId) {
    return (await prisma.bloomPayoutRequest.findMany({ where: { userId }, orderBy: { month: 'asc' } })).map(toRequest);
  },
  async addRequest(userId, r) {
    return toRequest(await prisma.bloomPayoutRequest.create({ data: { userId, ...r } }));
  },
  async setSent(userId, id, sentDate, sentCents, txnId) {
    await prisma.bloomPayoutRequest.updateMany({ where: { id, userId, sentDate: null }, data: { sentDate, sentCents, sentTxnId: txnId } });
  },
  async deposits(userId): Promise<Deposit[]> {
    const goLive = await getGoLive(userId);
    const links = await prisma.bankMatch.findMany({ where: { userId, kind: 'darkbloom' }, include: { txn: { select: { postedDate: true, pending: true } } } });
    return links.filter(l => !l.txn.pending && l.txn.postedDate >= goLive).map(l => ({ txnId: l.txnId, date: l.txn.postedDate, cents: l.amountCents }));
  },
};

/** GET the ledger's detected withdrawal requests (read-only). Null when BLOOM_LEDGER_URL is unset; throws on a bad answer. */
async function fetchWithdrawals(fetchFn: typeof fetch = fetch): Promise<LedgerWithdrawal[] | null> {
  const base = process.env.BLOOM_LEDGER_URL?.replace(/\/+$/, '');
  if (!base) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetchFn(`${base}/v1/withdrawals`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`ledger answered HTTP ${res.status}`);
    return parseWithdrawals(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Run after the invoice pull: copy 1 for new months, new requests from the ledger, deposit matching, copy 2. Owner only. */
export async function runBloomPayments(userId: number): Promise<PaymentRunResult | { notOwner: true }> {
  if (!(await isOwner(userId))) return { notOwner: true };
  return exclusive(userId, async () => {
    let w: LedgerWithdrawal[] | null = null;
    let err: string | null = null;
    try { w = await fetchWithdrawals(); } catch (e) { err = `withdrawals: ${e instanceof Error ? e.message : String(e)}`; }
    const r = await runPayments(store, userId, w);
    if (err) r.errors.push(err);
    return r;
  });
}

export async function addBloomRequest(userId: number, input: ManualInput) {
  return exclusive(userId, () => addManualRequest(store, userId, input));
}

/** The read-only payment view for the API and the pages. */
export async function loadPaymentRows(userId: number) {
  return paymentRows(await store.copies(userId), await store.requests(userId), laDay(new Date()));
}
