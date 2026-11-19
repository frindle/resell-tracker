// Mail in the order inbox that is positively known not to be an order, and
// the BuyingGroup deal-expired notice. Pure, no I/O.
//
// Only a known sender (matched on the retailer's own address, after the
// forwarding alias is unwrapped) together with a known subject shape counts.
// Anything else stays in the inbox for a person.

export type NoiseReason = 'promo' | 'sign-in' | 'survey' | 'policy' | 'welcome' | 'group-status' | 'apple-trial';
export type NoiseClass = {
  reason: NoiseReason;
  /** Skip the 7-day archive: the message holds a redemption code Penn does not want stored. */
  purge: boolean;
};

const domains = (senders: readonly string[]) => senders.map(a => a.slice(a.lastIndexOf('@') + 1).toLowerCase());
const onDomain = (senders: readonly string[], d: string) => domains(senders).some(x => x === d || x.endsWith(`.${d}`));

const PAYMENT_WORDS = /\b(?:payouts?|payments?|paid|refund(?:ed)?|received)\b/;

/** Why a message is not an order, or null when it is not positively known. */
export function classifyNonOrder(senders: readonly string[], rawSubject: string): NoiseClass | null {
  const subject = String(rawSubject ?? '').replace(/^\s*(?:(?:fwd?|fw)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!subject) return null;
  const note = (reason: NoiseReason, purge = false): NoiseClass => ({ reason, purge });

  if (onDomain(senders, 'cardcenter.cc')) {
    if (/^new sign-in\b/.test(subject)) return note('sign-in');
    // Duplicates the API state the tracker already syncs.
    if (/^(?:cards|reservations|tracking) submitted$/.test(subject)) return note('group-status');
    // "Store: 15% off ..." gift-card promos.
    // A payment / payout / refund notice is never a promo, whatever figures it carries.
    if (/^[^:]{2,50}:\s.*(?:\d\s*%|\$\s*\d[\d,.]*\s*off\b|gift\s*card|\bfree\b|bonus|\boff\b|daily drop)/.test(subject) && !PAYMENT_WORDS.test(subject)) return note('promo');
    return null;
  }
  if (onDomain(senders, 'buyformeretail.com') || onDomain(senders, 'bfmr.com')) {
    if (/^(?:cards|reservations|tracking) submitted$/.test(subject)) return note('group-status');
    // Deal blasts start with "deal(s)"; a payout or payment notice must stay a real email.
    if (/^(?:\w+\s+)?deals?\b|\bin stock\b|reservations added|black friday|same-day pay\b/.test(subject) && !PAYMENT_WORDS.test(subject)) return note('promo');
    return null;
  }
  if (onDomain(senders, 'walmart.com') || onDomain(senders, 'medallia.com')) {
    if (/\bsurvey\b|your recent feedback/.test(subject) && !/\border\b/.test(subject)) return note('survey');
    return null;
  }
  if (onDomain(senders, 'amazon.com') || onDomain(senders, 'wholefoodsmarket.com')) {
    if (/^your recent amazon purchase includes an? apple [a-z+ ]+ trial$/.test(subject)) return note('apple-trial', true);
    if (/^updates to our conditions of use/.test(subject) || /^your new subscription$/.test(subject)) return note('policy');
    return null;
  }
  if (onDomain(senders, 'lenovo.com')) {
    if (/^welcome to lenovo\b/.test(subject)) return note('welcome');
    return null;
  }
  return null;
}

/** What BuyingGroup's "Your Commitment Has Been Affected - Deal Expired" notice says. */
export type BgExpiry = {
  /** The commitment that was split and keeps the items already received; null when the notice names no split. */
  originalId: string | null;
  originalQuantity: number | null;
  /** The commitment that expired. */
  expiredId: string;
  expiredQuantity: number | null;
};

const CM_ID = /(CM-[A-Za-z0-9-]+)/;

function section(body: string, heading: RegExp): { id: string; qty: number | null } | null {
  const m = heading.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length, m.index + m[0].length + 400);
  const id = rest.match(new RegExp(`commitment:\\s*${CM_ID.source}`, 'i'));
  if (!id) return null;
  const q = rest.match(/quantity:\s*(\d{1,6})/i);
  return { id: id[1], qty: q ? parseInt(q[1], 10) : null };
}

export function parseBgExpiry(subject: string, body: string): BgExpiry | null {
  if (!/commitment has been affected/i.test(subject) || !/deal expired/i.test(subject)) return null;
  const text = String(body ?? '');
  const original = section(text, /original commitment[^\n]*/i);
  const remainder = section(text, /remainder commitment[^\n]*/i);
  if (remainder) return { originalId: original?.id ?? null, originalQuantity: original?.qty ?? null, expiredId: remainder.id, expiredQuantity: remainder.qty };
  // Nothing was received, so the commitment itself expired.
  const whole = text.match(new RegExp(`commitment:\\s*${CM_ID.source}`, 'i'));
  if (!whole) return null;
  return { originalId: null, originalQuantity: null, expiredId: whole[1], expiredQuantity: null };
}
