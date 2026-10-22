// Decides whether an order's received packages still fall short of its expected value,
// so the Amazon scraper should keep looking for more tracking numbers.
export interface CompletenessOrder {
  platform?: string | null
  orderNumber?: string | null
  orderDate?: Date | string | null
  salePrice?: number | null
  bgExpectedPayout?: number | null
  bgPaidAmount?: number | null
  trackingNumbers?: string | null
  trackingValues?: string | null
  bgCredited?: boolean | null
  bfmrReceived?: boolean | null
  lost?: boolean | null
  cancelled?: boolean | null
  salePriceSynced?: boolean | null
}

export function isAwaitingMoreShipments(o: CompletenessOrder, now: Date): boolean {
  // Guard 1: trackingNumbers must be a non-empty string after trimming
  const tracking = (o.trackingNumbers ?? '').trim()
  if (!tracking) return false

  // Guard 2: arrival signal
  const hasArrivalSignal =
    o.bgCredited === true ||
    o.bfmrReceived === true ||
    ((o.bgPaidAmount ?? 0) > 0)
  if (!hasArrivalSignal) return false

  // Guard 3: expected > 0
  const expected = Math.max(o.salePrice ?? 0, o.bgExpectedPayout ?? 0)
  if (expected <= 0) return false

  // Guard 4: compute received
  let tvSum = 0
  try {
    const parsed = JSON.parse(o.trackingValues ?? '{}')
    if (parsed && typeof parsed === 'object') {
      for (const v of Object.values(parsed)) {
        if (typeof v === 'number') tvSum += v
      }
    }
  } catch {
    tvSum = 0
  }
  const received = Math.max(o.bgPaidAmount ?? 0, tvSum)

  // Guard 5: shortfall check with 1% tolerance
  const threshold = expected - Math.max(1, expected * 0.01)
  if (received >= threshold) return false

  // Guard 6: not lost, cancelled, or salePriceSynced
  if (o.lost === true) return false
  if (o.cancelled === true) return false
  if (o.salePriceSynced === true) return false

  // Guard 7: Amazon orderNumber format
  if (!/^\d{3}-\d{7}-\d{7}$/.test(o.orderNumber ?? '')) return false

  // Guard 8: orderDate within 45 days
  const orderDateRaw = o.orderDate
  if (orderDateRaw == null) return false
  const orderDate = typeof orderDateRaw === 'string' ? new Date(orderDateRaw) : orderDateRaw
  if (isNaN(orderDate.getTime())) return false
  const diffDays = (now.getTime() - orderDate.getTime()) / 86_400_000
  if (diffDays > 45) return false

  return true
}
