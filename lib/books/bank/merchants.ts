// Group open bank debits by merchant, for the Merchants review tab. Pure: the service loads the rows.
import { retailerHit2, ruleMatches, type MatchRuleIn } from '../match.ts';

export type MerchantTxn = { id: number; accountId: number; postedDate: string; amountCents: number; description: string };
export type MerchantAccount = { id: number; name: string; mapped: boolean };
export type MerchantGroup = {
  key: string;
  /** What a rule should search for: text the descriptions actually contain. */
  pattern: string;
  count: number;
  totalCents: number;
  firstDate: string;
  lastDate: string;
  accounts: { id: number; name: string }[];
  samples: string[];
  /** An enabled rule already matches at least one row of the group. */
  ruled: boolean;
  /** Every row is on an account that is not in the books, so Ignore is allowed. */
  allUnmapped: boolean;
};

const PREFIXES = [
  /^(?:sq|tst|sp|pp|paypal|pypl|gglpay|google pay|apple pay|cko|ach|pos|dd|bt|fs|ic)\s*[*\-]+\s*/,
  /^(?:debit card purchase|checkcard purchase|checkcard|debit purchase|purchase authorized on \d{1,2}\/\d{1,2}|recurring payment|recurring|purchase|pos debit|pos)\s*[-:*]?\s+/,
  /^paypal\s+/,
];
const STOP = new Set(['the', 'inc', 'llc', 'ltd', 'co', 'corp', 'com', 'www', 'and', 'of', 'store', 'online', 'payment', 'purchase', 'us', 'usa']);
const STATES = new Set('al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc'.split(' '));

/** The merchant text of a description (lowercase) and a rule pattern it contains. A known retailer keeps its retailer key. */
export function merchantGroupKey(description: string): { key: string; pattern: string } {
  const lower = description.toLowerCase().replace(/\s+/g, ' ').trim();
  const known = retailerHit2(description);
  if (known) return { key: known.key, pattern: known.text };
  let s = lower;
  for (let i = 0; i < 3; i++) {
    let hit = false;
    for (const re of PREFIXES) { const n = s.replace(re, ''); if (n !== s) { s = n; hit = true; } }
    if (!hit) break;
  }
  let toks = s.replace(/[#*]/g, ' ').split(' ').map(t => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter(Boolean);
  toks = toks.filter(t => !/\d/.test(t) && /^[a-z&'.-]+$/.test(t) && t.length >= 2);
  // City and state tail: drop a trailing state code when other words remain.
  if (toks.length > 2 && STATES.has(toks[toks.length - 1])) toks.pop();
  const words = toks.filter(t => !STOP.has(t.replace(/\..*$/, '')));
  const use = (words.length > 0 ? words : toks).map(t => t.replace(/\.(com|net|org)$/, ''));
  const key = use.slice(0, 2).join(' ');
  if (!key) { const f = lower.slice(0, 20).trim(); return { key: f, pattern: f }; }
  // A rule matches by substring: keep the key only when the description really contains it, else its first word.
  if (lower.includes(key)) return { key, pattern: key };
  const first = use[0];
  if (first && lower.includes(first)) return { key: first, pattern: first };
  return { key, pattern: key };
}

/** Group open debits by merchant, largest total spend first. */
export function groupMerchants(txns: MerchantTxn[], accounts: MerchantAccount[], rules: MatchRuleIn[]): MerchantGroup[] {
  const acct = new Map(accounts.map(a => [a.id, a]));
  type Acc = { g: MerchantGroup; accIds: Set<number>; pats: Map<string, number> };
  const by = new Map<string, Acc>();
  for (const t of txns) {
    if (t.amountCents >= 0) continue;
    const { key, pattern } = merchantGroupKey(t.description);
    let a = by.get(key);
    if (!a) {
      a = { g: { key, pattern, count: 0, totalCents: 0, firstDate: t.postedDate, lastDate: t.postedDate, accounts: [], samples: [], ruled: false, allUnmapped: true }, accIds: new Set(), pats: new Map() };
      by.set(key, a);
    }
    const g = a.g;
    g.count++;
    g.totalCents += -t.amountCents;
    if (t.postedDate < g.firstDate) g.firstDate = t.postedDate;
    if (t.postedDate > g.lastDate) g.lastDate = t.postedDate;
    if (!a.accIds.has(t.accountId)) { a.accIds.add(t.accountId); g.accounts.push({ id: t.accountId, name: acct.get(t.accountId)?.name ?? `#${t.accountId}` }); }
    if (g.samples.length < 3 && !g.samples.includes(t.description)) g.samples.push(t.description);
    if (acct.get(t.accountId)?.mapped !== false) g.allUnmapped = false;
    a.pats.set(pattern, (a.pats.get(pattern) ?? 0) + 1);
    if (!g.ruled && rules.some(r => ruleMatches(r, t))) g.ruled = true;
  }
  return [...by.values()].map(a => {
    a.g.pattern = [...a.pats.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
    return a.g;
  }).sort((x, y) => y.totalCents - x.totalCents || x.key.localeCompare(y.key));
}
