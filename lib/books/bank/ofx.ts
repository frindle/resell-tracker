// OFX / QFX statement parser. Handles OFX 1.x (SGML: unclosed leaf tags, a text header) and 2.x (XML).
// Reads STMTTRN (DTPOSTED, TRNAMT, FITID, NAME, MEMO, DTUSER), LEDGERBAL, and enough of the account block to tell
// accounts apart. The full account number is never kept: only its last 4 digits and a one-way hash used as the id.
import { createHash } from 'node:crypto';
import { decimalToCents } from './money.ts';
import { assignHashIds } from './dedupe.ts';
import type { BankTxnIn } from './types.ts';

export const MAX_OFX_BYTES = 25 * 1024 * 1024;

export type OfxStatement = {
  providerAccountId: string; // "ofx:" + hash
  org: string | null;
  kind: 'bank' | 'credit';
  last4: string | null;
  currency: string;
  balanceCents: number | null;
  balanceDate: string | null;
  transactions: BankTxnIn[];
};

export class OfxError extends Error {}

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, m => ENT[m]).trim();

/** YYYYMMDD[HHMMSS[.mmm][tz]] to YYYY-MM-DD (the calendar date as written). */
export function ofxDate(v: string | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec((v ?? '').trim());
  if (!m) return null;
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 2048).toUpperCase();
  return head.includes('OFXHEADER') || head.includes('<OFX');
}

type Tok = { tag: string; close: boolean; value: string };

function tokenize(body: string): Tok[] {
  const toks: Tok[] = [];
  const re = /<(\/?)([A-Za-z0-9_.]+)>([^<]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) toks.push({ tag: m[2].toUpperCase(), close: m[1] === '/', value: m[3] });
  return toks;
}

const hashId = (parts: string[]) => 'ofx:' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

export function parseOfx(input: string | Uint8Array): OfxStatement[] {
  const text = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  if (!looksLikeOfx(text)) throw new OfxError('not an OFX/QFX file');
  const start = text.search(/<OFX>/i);
  if (start < 0) throw new OfxError('no <OFX> body found');
  const toks = tokenize(text.slice(start));

  const org = toks.find(t => t.tag === 'ORG' && !t.close)?.value;
  const stmts: OfxStatement[] = [];
  let cur: (Omit<OfxStatement, 'providerAccountId' | 'transactions'> & { acctKey: string[]; rows: Omit<BankTxnIn, 'providerTxnId'>[]; fit: (string | null)[]; acctId: string }) | null = null;
  let txn: Record<string, string> | null = null;
  let inBal = false;
  let balAmt: string | undefined, balDt: string | undefined;
  let pendingCurrency = 'USD';

  const flush = () => {
    if (!cur) return;
    const c = cur;
    // Rows without a FITID get hash ids (with occurrence index among the rows lacking one); the rest use their FITID.
    const noId = assignHashIds(c.rows.filter((_, i) => !c.fit[i]));
    let k = 0;
    const used = new Map<string, number>();
    const transactions: BankTxnIn[] = c.rows.map((r, i) => {
      let id = c.fit[i] ? `fit:${c.fit[i]}` : noId[k++].providerTxnId;
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n > 0) id = `${id}#${n}`; // a bank that reuses a FITID inside one file: keep both rows
      return { ...r, providerTxnId: id };
    });
    stmts.push({
      providerAccountId: hashId([org ?? '', ...c.acctKey]), org: org ?? null, kind: c.kind, last4: c.last4,
      currency: c.currency, balanceCents: balAmt != null ? decimalToCents(balAmt) : null, balanceDate: ofxDate(balDt), transactions,
    });
    cur = null; balAmt = undefined; balDt = undefined;
  };

  for (const t of toks) {
    if (t.tag === 'CURDEF' && !t.close) { pendingCurrency = decode(t.value) || 'USD'; continue; }
    if ((t.tag === 'STMTRS' || t.tag === 'CCSTMTRS') && !t.close) {
      flush();
      cur = { kind: t.tag === 'CCSTMTRS' ? 'credit' : 'bank', org: org ?? null, last4: null, currency: pendingCurrency, balanceCents: null, balanceDate: null, acctKey: [], rows: [], fit: [], acctId: '' };
      balAmt = undefined; balDt = undefined;
      continue;
    }
    if ((t.tag === 'STMTRS' || t.tag === 'CCSTMTRS') && t.close) { flush(); continue; }
    if (!cur) continue;
    if (t.close) {
      if (t.tag === 'STMTTRN' && txn) txn = pushTxn(cur, txn);
      if (t.tag === 'LEDGERBAL') inBal = false;
      continue;
    }
    if (t.tag === 'STMTTRN') { if (txn) pushTxn(cur, txn); txn = {}; continue; }
    if (t.tag === 'LEDGERBAL') { if (txn) txn = pushTxn(cur, txn); inBal = true; continue; }
    if (txn) { txn[t.tag] = decode(t.value); continue; }
    if (inBal) {
      if (t.tag === 'BALAMT') balAmt = decode(t.value);
      if (t.tag === 'DTASOF') balDt = decode(t.value);
      continue;
    }
    if (t.tag === 'ACCTID' || t.tag === 'BANKID' || t.tag === 'BRANCHID' || t.tag === 'ACCTTYPE') {
      const v = decode(t.value);
      cur.acctKey.push(`${t.tag}=${v}`);
      if (t.tag === 'ACCTID') { cur.acctId = v; const d = v.replace(/\D/g, ''); cur.last4 = d.length >= 4 ? d.slice(-4) : null; }
    }
    if (t.tag === 'CURDEF') cur.currency = decode(t.value) || cur.currency;
  }
  if (txn && cur) pushTxn(cur, txn);
  flush();
  if (stmts.length === 0) throw new OfxError('no bank or card statement found in the file');
  return stmts;
}

function pushTxn(cur: { rows: Omit<BankTxnIn, 'providerTxnId'>[]; fit: (string | null)[] }, t: Record<string, string>): null {
  const posted = ofxDate(t.DTPOSTED) ?? ofxDate(t.DTUSER);
  const amt = decimalToCents(t.TRNAMT);
  if (!posted || amt == null) return null;
  const name = (t.NAME ?? '').trim();
  const memo = (t.MEMO ?? '').trim();
  cur.rows.push({
    postedDate: posted, transactedDate: ofxDate(t.DTUSER), amountCents: amt,
    description: name || memo || (t.TRNTYPE ?? '').trim() || 'Transaction', payee: name || null, memo: memo || null, pending: false,
  });
  cur.fit.push(t.FITID ? t.FITID : null);
  return null;
}
