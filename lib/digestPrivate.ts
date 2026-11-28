// What the queue's /api/digest-lines refuses, mirrored so a bad line is never sent. Shared by lib/digestLines.ts and lib/resetLines.ts.

export const MAX_LINE_CHARS = 200;

// The queue's rule (Python, re.I):
//   [@$¢-¥€]|\d{6,}|\b\d+[.,]\d{2}\b|\b(?:usd|eur|gbp|dollars?)\b
// Python's \d and \b are Unicode-aware for str patterns and JS's are not, so
// they are spelled out here: \d is \p{Nd}, and \b next to a word character is
// "no letter, number or _ on that side". Built from a string so the TS target
// (ES2017) doesn't reject the regex syntax; Node runs it natively.
const W = '[\\p{L}\\p{N}_]';
const PRIVATE_RE = new RegExp(
  `[@$\\u00A2-\\u00A5\\u20AC]|\\p{Nd}{6,}|(?<!${W})\\p{Nd}+[.,]\\p{Nd}{2}(?!${W})|(?<!${W})(?:usd|eur|gbp|dollars?)(?!${W})`,
  'iu',
);

/** Mirrors the queue's check, so a line it would reject is never sent. */
export function lineLooksPrivate(line: string): boolean {
  return PRIVATE_RE.test(line);
}

// The queue counts code points; cutting by them also never splits a surrogate pair.
export function cutLine(line: string): string {
  return Array.from(line).slice(0, MAX_LINE_CHARS).join('');
}

