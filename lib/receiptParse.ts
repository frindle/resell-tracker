// Pulls the fields useful for matching out of a receipt's OCR text lines:
// totals, the purchase date and the card's last 4. Pure, no I/O.
//
// OCR splits a receipt into short lines, often with the label and the amount
// on separate lines ("TOTAL" then "$123.45"), so every label looks at its own
// line first and then the next one.

export type ParsedReceipt = {
  total: number | null;
  subtotal: number | null;
  /** YYYY-MM-DD */
  date: string | null;
  last4: string[];
};

const MONEY = /\$?\s*(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b/;

function moneyIn(line: string): number | null {
  const m = line.match(MONEY);
  if (!m) return null;
  return Number(`${m[1].replace(/,/g, '')}.${m[2]}`);
}

function amountAfter(lines: string[], i: number): number | null {
  const own = moneyIn(lines[i]);
  if (own != null) return own;
  for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
    const v = moneyIn(lines[j]);
    if (v != null) return v;
  }
  return null;
}

const TOTAL_LABEL = /\b(grand\s+total|order\s+total|total\s+charged|amount\s+charged|total\s+paid|amount\s+paid|balance\s+due|total)\b/i;
const NOT_TOTAL = /\b(sub\s*-?\s*total|total\s+savings|total\s+items?|items?\s+total|total\s+tax|you\s+saved|number\s+of\s+items)\b/i;
const SUBTOTAL_LABEL = /\b(sub\s*-?\s*total)\b/i;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2015 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dateIn(line: string): string | null {
  let m = line.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = line.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) return iso(+m[3], +m[1], +m[2]);
  m = line.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (m) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = line.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/i);
  if (m) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

// "VISA ****1234", "XXXXXXXXXXXX1234", "ending in 1234", "Card # 1234",
// "Acct: ************1234". Requires a mask or a label so a bare 4-digit
// number (a store id, a quantity) is never read as a card.
const LAST4_PATTERNS = [
  /[x*•]{3,}\s*-?\s*(\d{4})\b/i,
  /\bending\s+(?:in\s+)?(\d{4})\b/i,
  /\b(?:visa|mastercard|master\s*card|amex|american\s+express|discover|debit|credit)\b[^\d]{0,12}(\d{4})\b/i,
  /\b(?:card|acct|account)\s*(?:#|no\.?|number)?\s*:?\s*[x*•]*\s*(\d{4})\b/i,
];

export function parseReceipt(texts: string[]): ParsedReceipt {
  const lines = texts.map(t => t.trim()).filter(Boolean);
  let total: number | null = null;
  let totalRank = -1;
  let subtotal: number | null = null;
  let date: string | null = null;
  const last4 = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (SUBTOTAL_LABEL.test(line)) {
      if (subtotal == null) subtotal = amountAfter(lines, i);
    } else if (TOTAL_LABEL.test(line) && !NOT_TOTAL.test(line)) {
      const v = amountAfter(lines, i);
      // A specific label ("order total", "grand total") beats a bare "total".
      const rank = /\btotal\b/i.test(line) && !/\b(grand|order)\s+total|charged|paid|balance/i.test(line) ? 0 : 1;
      if (v != null && rank > totalRank) { total = v; totalRank = rank; }
    }

    if (!date) date = dateIn(line);

    for (const p of LAST4_PATTERNS) {
      const m = line.match(p);
      if (m) { last4.add(m[1]); break; }
    }
  }

  return { total, subtotal, date, last4: [...last4] };
}
