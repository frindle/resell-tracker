export function normalizeReceiptNumber(raw: string | null | undefined): string {
  if (raw == null) return '';
  const cleaned = raw.replace(/[\s-]/g, '');
  if (cleaned === '' || /\D/.test(cleaned)) return '';
  return cleaned;
}

export function pickReceiptOrder(
  barcode: string,
  orders: { id: number; orderNumber: string | null }[],
): { kind: 'match'; orderId: number } | { kind: 'review'; reason: 'none' | 'ambiguous' } {
  const normBarcode = normalizeReceiptNumber(barcode);
  if (normBarcode === '') return { kind: 'review', reason: 'none' };
  const matching = orders.filter(
    (o) => normalizeReceiptNumber(o.orderNumber) === normBarcode,
  );
  if (matching.length === 0) return { kind: 'review', reason: 'none' };
  if (matching.length > 1) return { kind: 'review', reason: 'ambiguous' };
  return { kind: 'match', orderId: matching[0].id };
}
