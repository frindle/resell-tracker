// Gift codes / PINs printed on the back of a card pack, read from OCR lines.
//
// Costco multi-packs print each card's code as four groups of four
// ("GIFT CODE: XXXX XXXX XXXX XXXX", "PIN: XXXX XXXX XXXX XXXX"). OCR splits,
// joins and decorates these: groups run together ("ABCDEFGH IJKL MNOP"),
// commas or dots appear between groups, and the printed label bleeds into the
// tail ("... MNOPIN"). Each OCR line is read on its own: joining
// neighbouring lines made a word plus a number look like a code. This only proposes codes; a person confirms each one
// before it is saved (see app/api/giftcard-ocr/orders/[id]/apply).
//
// Pure, no I/O.

export type ReadGiftCode = {
  code: string;
  /** Merchant named on the photo near the code, when one is. */
  merchant: string | null;
  /** 'pin' when the line was labelled PIN, 'code' otherwise. */
  label: 'pin' | 'code';
};

const MERCHANTS: [RegExp, string][] = [
  [/\buber\s*eats\b|\buber\b/i, 'Uber Eats'],
  [/\bdoor\s*dash\b/i, 'DoorDash'],
  [/\bstarbucks\b/i, 'Starbucks'],
  [/\bapple\b/i, 'Apple'],
  [/\bamazon\b/i, 'Amazon'],
  [/\bxbox\b/i, 'Xbox'],
  [/\bplaystation\b/i, 'PlayStation'],
  [/\bnintendo\b/i, 'Nintendo'],
];

/** The merchant whose name appears most on the photo, or null. */
export function photoMerchant(texts: string[]): string | null {
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const [re, name] of MERCHANTS) if (re.test(t)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [name, c] of counts) if (c > n) { best = name; n = c; }
  return best;
}

const LABEL = /\b(?:gift\s*code|claim\s*code|redemption\s*code|pin|code)\b\s*[:#.]?/gi;
const SEP = '[\\s,.:;\\-]*';
const G = '([A-Z0-9]{4})';
const FOUR = new RegExp(`(?:^|[^A-Z0-9])${G}${SEP}${G}${SEP}${G}${SEP}${G}`, 'g');

export function readGiftCodes(texts: string[]): ReadGiftCode[] {
  const merchant = photoMerchant(texts);
  const out: ReadGiftCode[] = [];
  const seen = new Set<string>();
  for (const line of texts) {
    const label = /\bpin\b/i.test(line) ? 'pin' : 'code';
    // Codes are printed in capitals; matching case-sensitively keeps
    // lowercase prose ("the QR code or visit") from forming groups.
    const cleaned = line.replace(LABEL, ' ');
    for (const m of cleaned.matchAll(FOUR)) {
      const code = m.slice(1, 5).join('');
      if (!plausibleCode(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({ code, merchant, label });
    }
  }
  return out;
}

/**
 * Codes mix letters and digits through the string. A run of only digits is a
 * barcode or card number; letters then digits (or the reverse) in one block
 * each is a word beside a number ("UBER EATS 7999").
 */
export function plausibleCode(code: string): boolean {
  // A masked card number off a receipt ("XXXXXXXXXXXX3069", often OCR'd as
  // 0s or Os), or any string where one character makes up half of it.
  if ([...code.slice(0, 12)].filter(c => 'X0O*'.includes(c)).length >= 11) return false;
  const counts = new Map<string, number>();
  for (const c of code) counts.set(c, (counts.get(c) ?? 0) + 1);
  if (Math.max(...counts.values()) >= 8) return false;
  if (!/[A-Z]/.test(code) || !/\d/.test(code)) return false;
  if (/^[A-Z]+\d+$/.test(code) || /^\d+[A-Z]+$/.test(code)) return false;
  return true;
}

/** "ABCD1234EFGH5678" -> "ABCD 1234 EFGH 5678", as printed. */
export function formatGiftCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1 ');
}
