export function buildReplaceTrackingPayload(
  row: Record<string, unknown>,
  newTracking: string,
  dateRange: Record<string, unknown>,
): { tracker_data: Record<string, unknown>[]; dateRange: Record<string, unknown> } {
  const trimmed = newTracking.trim();

  if (trimmed === '') {
    throw new Error('newTracking is empty or whitespace-only');
  }

  const currentTracking = (row.tracking_number as string) ?? '';
  if (trimmed === currentTracking) {
    throw new Error('newTracking equals current tracking_number (no-op)');
  }

  if (row.type !== 'shipment') {
    throw new Error('row.type is not "shipment"');
  }

  if (row.status !== 'shipped') {
    throw new Error('row.status is not "shipped"');
  }

  const copy = { ...row, tracking_number: trimmed };

  return {
    tracker_data: [copy],
    dateRange,
  };
}

export function pickShipmentRow(
  rows: Array<Record<string, unknown>>,
  myTrackerId: string,
): Record<string, unknown> {
  const matches = rows.filter(
    (r) => r.type === 'shipment' && String(r.id) === String(myTrackerId),
  );

  if (matches.length === 0) {
    throw new Error(`No shipment row found with id ${myTrackerId}`);
  }

  if (matches.length > 1) {
    throw new Error(`Multiple shipment rows found with id ${myTrackerId}`);
  }

  return matches[0];
}
