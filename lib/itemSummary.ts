import { isUselessDescription, isPlaceholderDescription } from './gapFill.ts';

// An email summary names categories or counts, not items: "Electronics (1 items)", "3 items", "Computers, Tablets".
const COUNT_ONLY_RE = /^\d{1,3} items?$/i;
// A cut-off title: the email trimmed it and left an ellipsis.
const CUT_OFF_RE = /(…|\.{3})$/;
// Words an email uses for a whole category. A text made only of these (and separators) names no item.
const CATEGORY_WORDS = new Set([
  'electronics', 'computers', 'computer', 'tablets', 'tablet', 'laptops', 'laptop', 'accessories', 'home', 'kitchen', 'office',
  'products', 'product', 'items', 'item', 'wearable', 'technology', 'cell', 'phones', 'phone', 'video', 'games', 'toys', 'tools',
  'books', 'beauty', 'health', 'sports', 'outdoors', 'garden', 'grocery', 'pet', 'supplies', 'software', 'and', 'more',
]);

/**
 * True when the description is a summary rather than item names, so the order's page should be read for the real items:
 * blank, a store name, a category-and-count placeholder, a bare count, a cut-off title, or only category words.
 */
export function isItemSummary(desc: string | null | undefined): boolean {
  if (isUselessDescription(desc) || isPlaceholderDescription(desc)) return true;
  const d = String(desc).trim();
  if (COUNT_ONLY_RE.test(d) || CUT_OFF_RE.test(d)) return true;
  const words = d.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.length > 0 && words.every(w => CATEGORY_WORDS.has(w));
}
