// PayPal payment receipts, read from the text of the email. Pure, no I/O.
//
// A receipt tells which card paid for a purchase: the merchant, the amount,
// the date, the card network and last four digits (none when PayPal balance or
// a bank paid), and PayPal's transaction id. It does not carry the retailer's
// order number reliably (its "Order ID" / "Invoice ID" may be the merchant's or
// PayPal's own), so lib/paypalMatch.ts tries that number against the tracker's
// order numbers first, then falls back to merchant, amount and date.

export type PayPalReceipt = {
  merchant: string;
  /** Dollars. */
  amount: number;
  /** Transaction date as YYYY-MM-DD; '' when the email gives none. */
  date: string;
  /** "Visa", "Mastercard", "Amex", "Discover", or null when no card network is named. */
  network: string | null;
  last4: string | null;
  txnId: string;
  /** The "Order ID" / "Invoice ID" / "Invoice number" the receipt shows ('' when none). May be the merchant's order number. */
  orderRef: string;
};

/** True when the sender (or a forwarded sender) is PayPal's own mail. */
export function isPayPalSender(from: string | null | undefined): boolean {
  return /@(?:[a-z0-9-]+\.)*paypal\.[a-z]{2,}\b/i.test(String(from ?? ''));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Nov 15, 2026" or "November 15, 2026" as 2026-11-15; '' when it does not read as a date. */
export function paypalDate(s: string): string {
  const m = String(s ?? '').match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (!m) return '';
  const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mi < 0) return '';
  const day = parseInt(m[2], 10);
  if (day < 1 || day > 31) return '';
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MONEY = String.raw`\$\s*([\d,]+\.\d{2})`;
const SENTENCES = [
  new RegExp(String.raw`You authorized\s+${MONEY}\s*(?:USD)?\s+to\s+([^\n]+)`, 'i'),
  new RegExp(String.raw`You sent a payment of\s+${MONEY}\s*(?:USD)?\s+to\s+([^\n]+)`, 'i'),
  new RegExp(String.raw`You paid\s+${MONEY}\s*(?:USD)?\s+to\s+([^\n]+)`, 'i'),
  new RegExp(String.raw`You sent\s+${MONEY}\s*(?:USD)?\s+to\s+([^\n]+)`, 'i'),
];
const SUBJECT_RE = new RegExp(String.raw`^(.+?):\s*${MONEY}\s*(?:USD)?\s*$`, 'i');

const money = (s: string) => parseFloat(s.replace(/,/g, ''));

function cleanName(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

/** The value after a label: on the same line, else on the next non-empty line. */
function labelled(lines: readonly string[], label: RegExp): string {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label);
    if (!m) continue;
    const same = (m[1] ?? '').trim();
    if (same) return same;
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) if (lines[j]) return lines[j];
  }
  return '';
}

const NETWORKS: [RegExp, string][] = [
  [/\bvisa\b/i, 'Visa'],
  [/\bmaster\s?card\b/i, 'Mastercard'],
  [/\bamerican express\b|\bamex\b/i, 'Amex'],
  [/\bdiscover\b/i, 'Discover'],
];

// "••3069", "••••3069", "x-3069", "ending in 3069", "ending 3069".
const LAST4_RE = /(?:(?<![A-Za-z])[•*·xX]+[\s-]?|\bending(?:\s+in)?\s+)(\d{4})\b/;

function funding(lines: readonly string[]): { network: string | null; last4: string | null } {
  const at = lines.findIndex(l => /^(?:authorized with|paid with|funding source|payment method)\b/i.test(l));
  if (at < 0) return { network: null, last4: null };
  // The label line and the few lines under it name the funding source.
  const block = lines.slice(at, at + 4).join(' ');
  if (/paypal balance|bank account|\bchecking\b|\bsavings\b|\bbank\b/i.test(block) && !NETWORKS.some(([re]) => re.test(block))) {
    return { network: null, last4: null };
  }
  const network = NETWORKS.find(([re]) => re.test(block))?.[1] ?? null;
  const last4 = block.match(LAST4_RE)?.[1] ?? null;
  return { network, last4 };
}

/**
 * The receipt in a PayPal payment email, or null when `body` is not one (no
 * amount, merchant or transaction id found).
 */
export function parsePayPalReceipt(subject: string, body: string): PayPalReceipt | null {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ');
  // A forwarded receipt can arrive quoted ("> " in front of every line).
  const lines = text.split('\n').map(l => l.replace(/^(?:\s*>)+/, '').trim()).filter(Boolean);

  let amount = 0;
  let sentenceMerchant = '';
  for (const re of SENTENCES) {
    const m = text.match(re);
    if (m) { amount = money(m[1]); sentenceMerchant = cleanName(m[2]); break; }
  }
  const subj = String(subject ?? '').match(SUBJECT_RE);
  if (!amount && subj) amount = money(subj[2]);

  const merchant = cleanName(labelled(lines, /^merchant\b(?!\s+protection)\s*:?\s*(.*)$/i)) || sentenceMerchant || (subj ? cleanName(subj[1]) : '');
  const txnId = labelled(lines, /^transaction id\b\s*:?\s*(.*)$/i).match(/^[A-Z0-9]{8,24}$/i)?.[0].toUpperCase() ?? '';
  if (!(amount > 0) || !merchant || !txnId) return null;

  const orderRef = labelled(lines, /^(?:order id|order number|order no\.?|invoice id|invoice number|invoice no\.?|invoice)\b\s*:?\s*(.*)$/i).match(/^[A-Z0-9][A-Z0-9-]{3,31}$/i)?.[0] ?? '';
  const date = paypalDate(labelled(lines, /^transaction date\b\s*:?\s*(.*)$/i));
  return { merchant, amount, date, ...funding(lines), txnId, orderRef };
}
