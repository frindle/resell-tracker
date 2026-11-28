// BFMR ("Buy For Me Retail") payment emails: what was paid, the payment id, and the tracking numbers with their values.
// Reads the layout tolerantly (labels in any case, tracking and value on one line or on neighbouring lines); the shared
// helpers do the pairing. Pure.
import { dayIn, moneyCents, pairTrackingAmounts, type RemittanceParser } from './remittanceParse.ts';

const PAYMENT_SUBJECT = /\b(?:payments?|payouts?|paid)\b/i;
const NOT_PAYMENT = /\b(?:deals?|in stock|reservations? added|black friday)\b/i;
const REF = /\b(?:payment|payout|transaction|batch|reference)\s*(?:id|#|no\.?|number|ref(?:erence)?)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_-]{3,39})/i;
const TOTAL = /\b(?:total\s+(?:amount\s+)?(?:paid|payment|payout|sent|amount)?|amount\s+(?:paid|sent)|payment\s+amount|you(?:'ve| have)\s+been\s+paid)\s*:?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i;

export const bfmrPaymentParser: RemittanceParser = {
  group: 'bfmr',
  domains: ['bfmr.com', 'buyformeretail.com'],
  parse: ({ subject, body, day }) => {
    if (!PAYMENT_SUBJECT.test(subject) || (NOT_PAYMENT.test(subject) && !/\bpay(?:ment|out)\b/i.test(subject))) return null;
    const lines = pairTrackingAmounts(body);
    const labeled = body.match(TOTAL) ?? subject.match(TOTAL);
    const fromSubject = moneyCents(subject)[0];
    const totalCents = labeled ? Math.round(parseFloat(labeled[1].replace(/,/g, '')) * 100) : fromSubject ?? 0;
    if (!(totalCents > 0)) return null;
    const ref = (body.match(REF) ?? subject.match(REF))?.[1] ?? null;
    const dateLine = body.split(/\r?\n/).find(l => /\b(?:payment|paid|sent|processed)\s*date\b|\bdate\s*(?:paid|sent)\b/i.test(l));
    return { ref, totalCents, paidDay: (dateLine ? dayIn(dateLine) : null) ?? day, lines };
  },
};
