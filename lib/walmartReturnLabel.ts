import { fedexFromLinks, fedexFromText } from './emailParse.ts';

// A Walmart return-label email ("Your return label", "Print your return label", a QR code for a drop-off):
// the return's FedEx tracking number, so the order's return row gets its return-tracking field filled
// without typing it. Pure; the DB write is lib/walmartReturnLabelDb.ts. The tracking number is read
// only when the email is Walmart's, is about a return and names FedEx, so an order or delivery email
// (whose tracking is the outbound shipment) is never taken for one.

export type WalmartReturnLabel = { orderNumber: string; trackingNumbers: string[] };

const RETURN_SUBJECT_RE = /\breturn(?:s|ed)?\b.*\b(?:label|shipping|drop[- ]?off|qr|instructions|ready|started|request)\b|\b(?:label|qr|drop[- ]?off)\b.*\breturn/i;
// Mail about a return that is not a label: a refund notice, a "we received your return" notice.
const NOT_LABEL_RE = /\b(?:refund(?:ed)?\s+(?:issued|processed|on its way)|we(?:'ve| have)? received your return|return (?:received|complete|completed))\b/i;
const LABEL_BODY_RE = /\b(?:return label|shipping label|qr code|drop[- ]?off|print (?:the|your) label)\b/i;

/** Digits only, so "2000123-456789" and "2000123456789" compare equal. */
export const orderDigits = (s: string | null | undefined): string => String(s ?? '').replace(/\D/g, '');

export function parseWalmartReturnLabel(input: {
  platform: string; subject: string; body: string; html?: string; orderNumber?: string;
}): WalmartReturnLabel | null {
  if (input.platform !== 'Walmart') return null;
  const subject = String(input.subject ?? '');
  const body = String(input.body ?? '');
  if (!RETURN_SUBJECT_RE.test(subject) && !(/\breturn/i.test(subject) && LABEL_BODY_RE.test(body))) return null;
  if (NOT_LABEL_RE.test(subject)) return null;
  const orderNumber = String(input.orderNumber ?? '').trim();
  const text = `${subject}\n${body.replace(/https?:\/\/\S+/gi, ' ')}`;
  const found = [
    ...fedexFromLinks(`${body}\n${input.html ?? ''}`),
    ...fedexFromText(text, orderNumber),
  ];
  const trackingNumbers = [...new Set(found)];
  if (!trackingNumbers.length) return null;
  return { orderNumber, trackingNumbers };
}

export type ReturnRowLite = { id: number; status: string; returnTracking: string | null };

/**
 * The return row a label belongs to: the only row on the order with no return tracking that is still open
 * (requested or in transit). None when the order already has the number, or when more than one open
 * row lacks one (two labels for two returns cannot be told apart), or a label has several numbers.
 */
export function pickReturnRowForLabel(rows: readonly ReturnRowLite[], trackingNumbers: readonly string[]): { id: number; tracking: string } | null {
  const norm = (t: string) => t.replace(/\D/g, '');
  const have = new Set(rows.map(r => norm(r.returnTracking ?? '')).filter(Boolean));
  const fresh = [...new Set(trackingNumbers.map(norm).filter(t => t && !have.has(t)))];
  if (fresh.length !== 1) return null;
  const open = rows.filter(r => !r.returnTracking && (r.status === 'requested' || r.status === 'in_transit'));
  if (open.length !== 1) return null;
  return { id: open[0].id, tracking: fresh[0] };
}
