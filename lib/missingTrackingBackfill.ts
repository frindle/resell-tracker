import { PROCESSED_STATUSES } from './paymentStatus.ts';

export const MISSING_TRACKING_MAX_AGE_DAYS = 60;
export const AMAZON_ORDER_NUMBER_RE = /^(?:\d{3}|D\d{2})-\d{7}-\d{7}$/;

export function isAmazonOrderNumber(n: string | null | undefined): boolean {
  return typeof n === 'string' && AMAZON_ORDER_NUMBER_RE.test(n);
}

export type BackfillCandidate = {
  orderNumber: string | null;
  trackingNumbers: string | null;
  cancelled: boolean;
  lost: boolean;
  salePriceSynced: boolean;
  salePrice: number | null;
  bgExpectedPayout: number | null;
  bgPaidAmount: number | null;
  bgCredited: boolean;
  bfmrStatus: string | null;
};

export function isPaidInFull(o: BackfillCandidate): boolean {
  if (o.salePriceSynced) return true;
  const expected = o.bgExpectedPayout ?? o.salePrice;
  return o.bgPaidAmount != null && o.bgPaidAmount > 0 && expected != null && o.bgPaidAmount >= expected - 0.01;
}

export function isProcessed(o: BackfillCandidate): boolean {
  if (o.bgCredited) return true;
  if (o.bfmrStatus && PROCESSED_STATUSES.has(o.bfmrStatus.toLowerCase())) return true;
  return false;
}

export function isPendingForTrackingBackfill(o: BackfillCandidate): boolean {
  return !o.cancelled && !o.lost && !o.trackingNumbers && isAmazonOrderNumber(o.orderNumber) && !isPaidInFull(o) && !isProcessed(o);
}

export function missingTrackingWhere(userId: number, now: Date = new Date()) {
  const since = new Date(now.getTime() - MISSING_TRACKING_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  return {
    userId,
    cancelled: false,
    lost: false,
    salePriceSynced: false,
    orderDate: { gte: since },
    orderNumber: { not: null },
    OR: [{ trackingNumbers: null }, { trackingNumbers: '' }],
  };
}

export const MISSING_TRACKING_SELECT = {
  orderNumber: true,
  trackingNumbers: true,
  cancelled: true,
  lost: true,
  salePriceSynced: true,
  salePrice: true,
  bgExpectedPayout: true,
  bgPaidAmount: true,
  bgCredited: true,
  bfmrStatus: true,
} as const;

export function selectBackfillOrderNumbers(rows: BackfillCandidate[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of rows) {
    if (isPendingForTrackingBackfill(r) && r.orderNumber != null && !seen.has(r.orderNumber)) {
      seen.add(r.orderNumber);
      result.push(r.orderNumber);
    }
  }
  return result;
}
