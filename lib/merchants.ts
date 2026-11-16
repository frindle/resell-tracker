import { emailAddresses, type EmailPlatform } from './emailParse.ts';

// Stores the email parser has no special handling for. The parser still finds
// the order number, total, address and tracking in their emails; what it can't
// know is whether a sender is a store at all. So the first email from a new
// store waits on the Email tab, and importing it there teaches the tracker the
// store's email domain and name. After that its emails import on their own,
// under that name instead of "Other".

export type LearnedMerchant = { domain: string; name: string };

export type ResolvedMerchant = {
  platform: string; // what the order's platform is set to
  known: boolean; // a built-in store or one a person has confirmed
  domain: string | null; // the sender's domain, e.g. "bestbuy.com"
};

export const MERCHANTS_KEY = 'email_merchants';

// "co.uk", "com.au": the store name is one label further left.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);

/** The sender's registrable domain ("orders@e.bestbuy.com" -> "bestbuy.com"), or null. */
export function senderDomain(from: string | null | undefined): string | null {
  const addr = emailAddresses(from)[0];
  if (!addr) return null;
  const labels = addr.split('@')[1]?.split('.').filter(Boolean) ?? [];
  if (labels.length < 2) return null;
  const n = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-n).join('.');
}

// Display names that say nothing about which store it is.
const GENERIC_NAME = /^(?:no[\s-]?reply|do[\s-]?not[\s-]?reply|orders?|order (?:status|updates?|confirmation)|customer (?:service|care|support)|support|info|shipping|notifications?|team|sales|store|shop)$/i;

/** A store name for the review screen: the sender's display name, else its domain. */
export function guessMerchantName(from: string | null | undefined): string {
  const s = String(from ?? '');
  const display = s.replace(/<[^>]*>/g, '').replace(/["']/g, '').replace(/\s+/g, ' ').trim();
  if (display && !display.includes('@') && !GENERIC_NAME.test(display)) return display.slice(0, 60);
  const domain = senderDomain(s);
  if (!domain) return 'Other';
  const label = domain.split('.')[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function parseLearnedMerchants(json: string | null | undefined): LearnedMerchant[] {
  try {
    const v = JSON.parse(String(json ?? '[]'));
    if (!Array.isArray(v)) return [];
    return v.filter(m => m && typeof m.domain === 'string' && typeof m.name === 'string' && m.domain && m.name.trim())
      .map(m => ({ domain: String(m.domain).toLowerCase(), name: String(m.name).trim().slice(0, 60) }));
  } catch {
    return [];
  }
}

/** Adds or renames one store; the list stays one entry per domain. */
export function learnMerchant(list: readonly LearnedMerchant[], domain: string, name: string): LearnedMerchant[] {
  const d = domain.trim().toLowerCase();
  const n = name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!d || !n || n.toLowerCase() === 'other') return [...list];
  return [...list.filter(m => m.domain !== d), { domain: d, name: n }];
}

export function resolveMerchant(platform: EmailPlatform, from: string, learned: readonly LearnedMerchant[]): ResolvedMerchant {
  const domain = senderDomain(from);
  if (platform !== 'Unknown') return { platform, known: true, domain };
  const hit = domain ? learned.find(m => m.domain === domain) : undefined;
  return hit ? { platform: hit.name, known: true, domain } : { platform: guessMerchantName(from), known: false, domain };
}
