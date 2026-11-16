// Picks the buyer (buying group) an order ships to from the shipping rules,
// the group addresses on file.
//
// 1. A rule's pattern found in the address (unchanged behaviour).
// 2. Otherwise the city: Amazon's emails give only "Name, CITY, ST", so a full
//    rule address never appears in them. The city must appear in a rule
//    address, the state must agree when the rule names one, and when the order
//    address has a street number the rule must have the same number. Used only
//    when every rule that matches this way names the same buyer.

export type AddressRule = { pattern: string; buyerId: number | null };

const STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR').split(' '));

const STATE_SEG = /^(?:us-)?([a-z]{2})(?:-us)?(?:\s+\d{5}(?:-\d{4})?)?$/i;
const STREET_NO = /(?:^|[,\n])\s*(\d+)[a-z]?\s+[a-z]/i;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** City and state from an address's last segments ("…, City, ST 12345"), or null. */
export function cityState(address: string): { city: string; state: string | null } | null {
  const segs = address.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  // A trailing country segment ("US", "USA", "United States").
  while (segs.length && /^(?:us|usa|united states)$/i.test(segs[segs.length - 1])) segs.pop();
  let i = segs.length - 1;
  if (i < 0) return null;
  // A bare ZIP after the state: "…, Hudson, NH, 03051".
  if (/^\d{5}(?:-\d{4})?$/.test(segs[i]) && i >= 1) i--;
  let cityText: string;
  let state: string;
  const m = segs[i].match(STATE_SEG);
  if (m && STATES.has(m[1].toUpperCase()) && i >= 1) {
    state = m[1].toUpperCase();
    cityText = segs[i - 1];
  } else {
    // "City ST 12345" in one segment.
    const one = segs[i].match(/^(.*?[a-z])\s+([a-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/i);
    if (!one || !STATES.has(one[2].toUpperCase())) return null;
    state = one[2].toUpperCase();
    cityText = one[1];
  }
  // Amazon: "Name - City, ST".
  const city = norm(cityText.split(/\s+-\s+/).pop() ?? '');
  if (!/[a-z]/.test(city) || /\d/.test(city)) return null;
  return { city, state };
}

function cityMatches(pattern: string, city: string, state: string | null, streetNo: string | null): boolean {
  const p = norm(pattern);
  const at = p.search(new RegExp(`(?:^|[^a-z])${escape(city)}(?![a-z])`));
  if (at < 0) return false;
  // A state named right after the city in the rule must agree.
  const after = p.slice(at).replace(new RegExp(`^[^a-z]?${escape(city)}`), '');
  const ruleState = after.match(/^\s*,?\s*(?:us-)?([a-z]{2})\b/);
  if (state && ruleState && STATES.has(ruleState[1].toUpperCase()) && ruleState[1].toUpperCase() !== state) return false;
  if (streetNo && !new RegExp(`(?:^|\\D)${streetNo}(?!\\d)`).test(p)) return false;
  return true;
}

export function matchShippingRule<T extends AddressRule>(address: string | null | undefined, rules: readonly T[]): T | undefined {
  const addr = String(address ?? '');
  if (!addr.trim()) return undefined;
  const lower = addr.toLowerCase();
  const exact = rules.find(r => r.pattern.trim() && lower.includes(r.pattern.toLowerCase()));
  if (exact) return exact;

  const cs = cityState(addr);
  if (!cs) return undefined;
  const streetNo = addr.match(STREET_NO)?.[1] ?? null;
  const hits = rules.filter(r => r.buyerId != null && cityMatches(r.pattern, cs.city, cs.state, streetNo));
  const buyers = new Set(hits.map(r => r.buyerId));
  return buyers.size === 1 ? hits[0] : undefined;
}
