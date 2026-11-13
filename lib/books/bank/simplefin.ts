// SimpleFIN Bridge client (protocol v2). Pure: takes a fetch implementation, never touches the database.
//
// Protocol (https://www.simplefin.org/protocol.html, developer guide at https://beta-bridge.simplefin.org/info/developers):
//  - The user creates a Setup Token at the bridge. It is a base64-encoded claim URL.
//  - POST (empty body) to the claim URL once. The response body is the Access URL: https://USER:PASS@host/simplefin.
//    A second claim, or a bad token, answers 403, which may mean the token was stolen and used by someone else.
//  - GET {accessUrl}/accounts?version=2&start-date=<epoch>&end-date=<epoch>&pending=1 with HTTP Basic auth.
//    start-date is inclusive, end-date exclusive. 402 = payment required, 403 = access revoked / bad credentials.
//  - The response has `errlist` (structured: code, msg, conn_id, account_id) and the deprecated `errors` (strings).
//    The bridge says to always show these to the user (e.g. a bank that needs re-authentication, or rate-limit warnings).
//
// Limits (SimpleFIN Bridge developer guide, checked 2026-11-12):
//  - Expect to make 24 requests per day or fewer (a little more is tolerated during initial setup; quota replenishes
//    through the day). Going over adds warnings to the errors array, going well over disables the Access Token.
//    GET /accounts (all) and GET /accounts?account=... have separate quotas.
//  - Each request's date range is limited to 90 days. Available history depends on the institution.
//  - Overlap windows by about 5 days so boundary transactions are not missed; fetch at an odd minute, not on the hour.
//
// The Access URL is a credential. It is never logged, never put in an Error message, never returned by a route.
import { laDay } from '../dates.ts';
import { decimalToCents } from './money.ts';
import type { BankAcctIn, BankTxnIn, FeedError } from './types.ts';

export const MAX_DAYS_PER_REQUEST = 90;
export const DAILY_REQUEST_BUDGET = 24;
export const OVERLAP_DAYS = 5;

export class SimpleFinError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SimpleFinError';
    this.status = status;
  }
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
export type ClientOpts = { fetch?: FetchLike; /** tests only: allow http:// to 127.0.0.1 */ allowInsecureLocal?: boolean };

const realFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

function checkHttps(u: URL, opts: ClientOpts) {
  if (u.protocol === 'https:') return;
  if (opts.allowInsecureLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return;
  throw new SimpleFinError('the SimpleFIN address must use https');
}

/** Decode a Setup Token to its claim URL (validated, https only). */
export function decodeSetupToken(token: string, opts: ClientOpts = {}): string {
  const cleaned = token.trim().replace(/\s+/g, '');
  if (!cleaned) throw new SimpleFinError('paste the SimpleFIN Setup Token');
  let decoded = '';
  try { decoded = Buffer.from(cleaned, 'base64').toString('utf8').trim(); } catch { /* handled below */ }
  let u: URL;
  try { u = new URL(decoded); } catch { throw new SimpleFinError('that does not look like a SimpleFIN Setup Token'); }
  checkHttps(u, opts);
  if (u.username || u.password) throw new SimpleFinError('that does not look like a SimpleFIN Setup Token');
  return u.toString();
}

/** Claim a Setup Token: POST once, get the Access URL. The token is single use. */
export async function claimSetupToken(token: string, opts: ClientOpts = {}): Promise<string> {
  const claimUrl = decodeSetupToken(token, opts);
  const f = opts.fetch ?? realFetch;
  let res;
  try {
    res = await f(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  } catch {
    throw new SimpleFinError('could not reach SimpleFIN to claim the token');
  }
  if (res.status === 403) {
    throw new SimpleFinError('SimpleFIN refused the token: it is unknown or was already claimed. If you did not claim it yourself, someone else may have it: treat your bank data as exposed and revoke access at the SimpleFIN Bridge.', 403);
  }
  if (!res.ok) throw new SimpleFinError(`SimpleFIN claim failed (HTTP ${res.status})`, res.status);
  const accessUrl = (await res.text()).trim();
  parseAccessUrl(accessUrl, opts); // validates shape without echoing it
  return accessUrl;
}

type Parsed = { base: string; auth: string };
function parseAccessUrl(accessUrl: string, opts: ClientOpts): Parsed {
  let u: URL;
  try { u = new URL(accessUrl); } catch { throw new SimpleFinError('SimpleFIN returned an unusable access address'); }
  checkHttps(u, opts);
  if (!u.username) throw new SimpleFinError('SimpleFIN returned an access address without credentials');
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  u.username = '';
  u.password = '';
  return { base: u.toString().replace(/\/+$/, ''), auth };
}

export type AccountsResult = { accounts: BankAcctIn[]; errors: FeedError[]; requests: number };

function epoch(day: string): number {
  return Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000);
}
const dayOfEpoch = (e: number) => laDay(new Date(e * 1000));

export function kindGuess(name: string, org: string | null): BankAcctIn['kind'] {
  const t = `${name} ${org ?? ''}`.toLowerCase();
  if (/\b(credit|card|visa|mastercard|amex|american express|bilt|synchrony|discover)\b/.test(t)) return 'credit';
  if (/\b(brokerage|robinhood|invest|ira|401k|roth)\b/.test(t)) return 'investment';
  if (/\b(checking|savings|money market|bank|chequing)\b/.test(t)) return 'bank';
  return 'other';
}

export function last4Guess(name: string): string | null {
  const m = /(?:x{2,}|\*{2,}|\.{2,}|•{2,}|#|\()\s*(\d{4})\)?\s*$/i.exec(name.trim()) ?? /\b(\d{4})\)?\s*$/.exec(name.trim());
  return m ? m[1] : null;
}

type RawTxn = { id?: unknown; posted?: unknown; amount?: unknown; description?: unknown; transacted_at?: unknown; pending?: unknown };
type RawAcct = { id?: unknown; name?: unknown; conn_id?: unknown; currency?: unknown; balance?: unknown; 'balance-date'?: unknown; transactions?: RawTxn[] };

/** Turn one /accounts response body into normalized accounts and errors. Throws on a malformed body. */
export function normalizeAccountSet(body: unknown): { accounts: BankAcctIn[]; errors: FeedError[] } {
  if (!body || typeof body !== 'object') throw new SimpleFinError('SimpleFIN sent an unreadable response');
  const b = body as { errlist?: unknown; errors?: unknown; connections?: unknown; accounts?: unknown };
  const orgByConn = new Map<string, string>();
  if (Array.isArray(b.connections)) {
    for (const c of b.connections as Record<string, unknown>[]) if (typeof c?.conn_id === 'string') orgByConn.set(c.conn_id, String(c.name ?? c.org_id ?? ''));
  }
  const errors: FeedError[] = [];
  const seenMsg = new Set<string>();
  if (Array.isArray(b.errlist)) {
    for (const e of b.errlist as Record<string, unknown>[]) {
      const msg = String(e?.msg ?? '');
      errors.push({ code: String(e?.code ?? 'gen'), msg, connId: e?.conn_id != null ? String(e.conn_id) : null, accountId: e?.account_id != null ? String(e.account_id) : null });
      seenMsg.add(msg);
    }
  }
  if (Array.isArray(b.errors)) {
    for (const m of b.errors) if (typeof m === 'string' && !seenMsg.has(m)) errors.push({ code: 'gen', msg: m, connId: null, accountId: null });
  }
  if (!Array.isArray(b.accounts)) throw new SimpleFinError('SimpleFIN sent a response without an accounts list');
  const accounts: BankAcctIn[] = [];
  for (const a of b.accounts as RawAcct[]) {
    if (typeof a?.id !== 'string' || !a.id) continue;
    const name = String(a.name ?? 'Account');
    const org = typeof a.conn_id === 'string' ? (orgByConn.get(a.conn_id) || null) : null;
    const balDate = typeof a['balance-date'] === 'number' && a['balance-date'] > 0 ? dayOfEpoch(a['balance-date']) : null;
    const txns: BankTxnIn[] = [];
    for (const t of a.transactions ?? []) {
      if (typeof t?.id !== 'string' || !t.id) continue;
      const amountCents = decimalToCents(t.amount as string);
      if (amountCents == null) continue;
      const pending = t.pending === true;
      const posted = typeof t.posted === 'number' ? t.posted : 0;
      const transacted = typeof t.transacted_at === 'number' && t.transacted_at > 0 ? t.transacted_at : 0;
      // A pending transaction may carry posted = 0: fall back to when it happened.
      const when = posted > 0 ? posted : transacted;
      if (when <= 0) continue;
      const description = String(t.description ?? '').trim();
      txns.push({
        providerTxnId: t.id, postedDate: dayOfEpoch(when), transactedDate: transacted > 0 ? dayOfEpoch(transacted) : null,
        amountCents, description, payee: null, memo: null, pending,
      });
    }
    accounts.push({
      providerAccountId: a.id, name, orgName: org, currency: typeof a.currency === 'string' && a.currency ? a.currency : 'USD',
      kind: kindGuess(name, org), last4: last4Guess(name), balanceCents: decimalToCents(a.balance as string),
      balanceDate: balDate, transactions: txns,
    });
  }
  return { accounts, errors };
}

/** Split [startDay, endDay) into windows of at most 90 days, oldest first. */
export function dateWindows(startDay: string, endDay: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let cur = epoch(startDay);
  const end = epoch(endDay);
  const span = MAX_DAYS_PER_REQUEST * 86400;
  while (cur < end) {
    const next = Math.min(cur + span, end);
    out.push({ start: new Date(cur * 1000).toISOString().slice(0, 10), end: new Date(next * 1000).toISOString().slice(0, 10) });
    cur = next;
  }
  return out;
}

/**
 * Fetch accounts and transactions for [startDay, endDay) (YYYY-MM-DD, end exclusive), one request per 90-day window.
 * Accounts from later windows merge into earlier ones (transactions concatenated, newest balance wins).
 * Throws SimpleFinError for 402/403/other HTTP failures; the message never contains the Access URL.
 */
export async function fetchAccounts(accessUrl: string, range: { startDay: string; endDay: string }, opts: ClientOpts = {}): Promise<AccountsResult> {
  const { base, auth } = parseAccessUrl(accessUrl, opts);
  const f = opts.fetch ?? realFetch;
  const windows = dateWindows(range.startDay, range.endDay);
  if (windows.length === 0) throw new SimpleFinError('empty date range');
  const byId = new Map<string, BankAcctIn>();
  const errors: FeedError[] = [];
  const seenErr = new Set<string>();
  let requests = 0;
  for (const w of windows) {
    const qs = `version=2&pending=1&start-date=${epoch(w.start)}&end-date=${epoch(w.end)}`;
    let res;
    requests++;
    try {
      res = await f(`${base}/accounts?${qs}`, { method: 'GET', headers: { Authorization: auth, Accept: 'application/json' } });
    } catch {
      throw new SimpleFinError('could not reach SimpleFIN');
    }
    if (res.status === 402) throw new SimpleFinError('SimpleFIN says payment is required: check the Bridge subscription.', 402);
    if (res.status === 403) throw new SimpleFinError('SimpleFIN refused the saved access (revoked or wrong credentials). Reconnect with a new Setup Token.', 403);
    if (!res.ok) throw new SimpleFinError(`SimpleFIN request failed (HTTP ${res.status})`, res.status);
    let body: unknown;
    try { body = JSON.parse(await res.text()); } catch { throw new SimpleFinError('SimpleFIN sent an unreadable response'); }
    const set = normalizeAccountSet(body);
    for (const e of set.errors) {
      const k = `${e.code}|${e.connId}|${e.accountId}|${e.msg}`;
      if (!seenErr.has(k)) { seenErr.add(k); errors.push(e); }
    }
    for (const a of set.accounts) {
      const have = byId.get(a.providerAccountId);
      if (!have) { byId.set(a.providerAccountId, a); continue; }
      have.transactions.push(...a.transactions);
      have.balanceCents = a.balanceCents ?? have.balanceCents;
      have.balanceDate = a.balanceDate ?? have.balanceDate;
    }
  }
  return { accounts: [...byId.values()], errors, requests };
}
