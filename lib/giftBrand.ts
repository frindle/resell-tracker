// One name per gift card brand. Some brands are sold and entered under more
// than one name for the same card: an Uber gift card is the Uber Eats card
// (Costco's receipt says UBER EATS, the card works for both), so the tracker
// treats them as one brand. Applied when a card is saved and when cards are
// grouped, so older rows saved under the other name still land together.
//
// Pure, no I/O.

const ALIASES: Array<[RegExp, string]> = [
  [/^uber\s*(eats)?(\s+(e-?gift|gift)(\s*card)?|\s+gc)?$/i, 'Uber Eats'],
];

/** The brand's canonical name, or the trimmed input when it has no alias. */
export function canonicalGiftBrand(name: string): string {
  const s = String(name ?? '').trim().replace(/\s+/g, ' ');
  for (const [re, canon] of ALIASES) if (re.test(s)) return canon;
  return s;
}
