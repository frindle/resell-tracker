// BuyingGroup.com receipt emails ("Enclosed is your RECEIPT - ID R-… from
// buyinggroup.com"). They are never store orders (see isGroupSender in
// emailMessage.ts); each one just means a receipt now exists on BuyingGroup,
// so the receipt sync runs at once instead of waiting for the next poll.
// Pure: the inbox, the sync and Pushover are wired in emailAutoImport.ts.

export type BgReceipt = { receiptId: string; trackingNumbers: string[] };

const SUBJECT_RE = /enclosed is your receipt\s*-?\s*id\s*:?\s*(R-[A-Z0-9]+)/i;
const BODY_ID_RE = /^\s*receipt id\s*:\s*(R-[A-Z0-9]+)\s*$/im;
const TRACKING_RE = /^[ \t>]*tracking\s*#\s*:\s*([A-Z0-9]{8,40})\s*$/gim;

/** Upper-case letters and digits only, so the same number compares equal however it was typed. */
export const normTracking = (s: string | null | undefined): string => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** The receipt id and tracking number(s) in a receipt email, or null when it is not one. */
export function parseBgReceipt(subject: string, body: string): BgReceipt | null {
  const text = String(body ?? '');
  const id = String(subject ?? '').match(SUBJECT_RE)?.[1] ?? (/receipt/i.test(subject ?? '') ? text.match(BODY_ID_RE)?.[1] : undefined);
  if (!id) return null;
  const trackingNumbers = [...new Set([...text.matchAll(TRACKING_RE)].map(m => normTracking(m[1])))];
  return { receiptId: id.toUpperCase(), trackingNumbers };
}

/** An inbox receipt email, as planned by planAutoImport. */
export type BgReceiptEmail = { id: string; receiptId: string; trackingNumbers: string[] };

/** Receipts whose tracking matches none of the order tracking numbers (a receipt with no tracking never matches). */
export function unmatchedReceipts<T extends { trackingNumbers: readonly string[] }>(receipts: readonly T[], orderTracking: Iterable<string>): T[] {
  const have = new Set<string>();
  for (const t of orderTracking) for (const part of String(t ?? '').split(',')) { const n = normTracking(part); if (n) have.add(n); }
  return receipts.filter(r => !r.trackingNumbers.some(t => have.has(normTracking(t))));
}

export const BG_RECEIPT_DEBOUNCE_MS = 2 * 60 * 1000;

/** The receipt sync runs for a receipt email unless it already ran within the debounce window. */
export function shouldRunReceiptSync(now: number, lastRunAt: number | null, debounceMs = BG_RECEIPT_DEBOUNCE_MS): boolean {
  return lastRunAt == null || now - lastRunAt >= debounceMs;
}

/** A failed receipt sync waits this long before the next try, so one broken login does not cost a full sync every poll. */
export const BG_RECEIPT_BACKOFF_MS = 45 * 60 * 1000;
/** After this many failures in a row, or this long since the first, the receipt emails are alerted on and deleted. */
export const BG_RECEIPT_MAX_FAILURES = 5;
export const BG_RECEIPT_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export type ReceiptFailState = { failures: number; firstAt: number | null; retryAt: number };
export const NO_RECEIPT_FAILURES: ReceiptFailState = { failures: 0, firstAt: null, retryAt: 0 };

/** The state after one more failed receipt sync, and whether to stop retrying. */
export function afterReceiptFailure(prev: ReceiptFailState, now: number): { state: ReceiptFailState; giveUp: boolean } {
  const failures = prev.failures + 1;
  const firstAt = prev.firstAt ?? now;
  const giveUp = failures >= BG_RECEIPT_MAX_FAILURES || now - firstAt >= BG_RECEIPT_GIVE_UP_MS;
  return { state: giveUp ? NO_RECEIPT_FAILURES : { failures, firstAt, retryAt: now + BG_RECEIPT_BACKOFF_MS }, giveUp };
}

/** Receipt ids not alerted yet, one entry per receipt (an original and its forward share an id). */
export function freshAlerts<T extends { receiptId: string }>(receipts: readonly T[], alerted: readonly string[], kind: 'fail' | 'nomatch'): T[] {
  const seen = new Set(alerted);
  const out: T[] = [];
  for (const r of receipts) {
    const key = alertKey(kind, r.receiptId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export const alertKey = (kind: 'fail' | 'nomatch', receiptId: string): string => `bgrcpt:${kind}:${receiptId}`;

export function receiptAlertText(kind: 'fail' | 'nomatch', receiptIds: readonly string[], gaveUp = false): string {
  const ids = [...new Set(receiptIds)].join(', ');
  return kind === 'fail'
    ? gaveUp
      ? `BuyingGroup receipt sync kept failing for ${ids}. The email was removed from the inbox; run the BuyingGroup sync by hand.`
      : `BuyingGroup receipt sync failed for ${ids}. The email stays in the inbox and retries.`
    : `BuyingGroup receipt ${ids}: its tracking matches no order in the tracker. Check it on the BuyingGroup page.`;
}

/** What runBgReceiptSync reported. */
export type ReceiptSyncSummary = { failed: number; synced: number; failedUserIds: readonly number[] };

/**
 * Receipt emails are not tied to a user, so one user's broken login must not
 * keep them (or delete them) for everyone: 'partial' means every failure was a
 * single user's and at least one other user synced, which counts as done.
 */
export function receiptSyncOutcome(s: ReceiptSyncSummary): 'ok' | 'partial' | 'failed' {
  if (s.failed === 0) return 'ok';
  return s.synced > 0 && s.failed === s.failedUserIds.length ? 'partial' : 'failed';
}

export const BG_USER_FAIL_ALERT_MS = 24 * 60 * 60 * 1000;

export const userSyncFailText = (): string =>
  'Your BuyingGroup receipt sync is failing. Check your BuyingGroup login in the tracker and run the sync by hand.';

/** Users not told about their failing sync within the last day. */
export function dueUserFailAlerts(userIds: readonly number[], lastAlertAt: ReadonlyMap<number, number>, now: number): number[] {
  return userIds.filter(id => now - (lastAlertAt.get(id) ?? -Infinity) >= BG_USER_FAIL_ALERT_MS);
}

export type ReceiptNotice = { to: number[] | 'all'; text: string };

/**
 * A whole-run receipt sync failure: the next retry state, and the alerts. Fresh
 * receipts are named once; when giving up, every receipt being removed is
 * named, whether or not it was alerted before. Goes to the failing users when
 * known, else to everyone.
 */
export function planReceiptFailure<T extends { receiptId: string }>(
  receipts: readonly T[], alerted: readonly string[], fail: ReceiptFailState, now: number, failedUserIds: readonly number[],
): { state: ReceiptFailState; giveUp: boolean; notices: ReceiptNotice[]; newKeys: string[] } {
  const next = afterReceiptFailure(fail, now);
  const fresh = freshAlerts(receipts, alerted, 'fail');
  const named = next.giveUp ? receipts : fresh;
  const to: number[] | 'all' = failedUserIds.length ? [...failedUserIds] : 'all';
  const notices = named.length ? [{ to, text: receiptAlertText('fail', named.map(r => r.receiptId), next.giveUp) }] : [];
  return { state: next.state, giveUp: next.giveUp, notices, newKeys: fresh.map(r => alertKey('fail', r.receiptId)) };
}
