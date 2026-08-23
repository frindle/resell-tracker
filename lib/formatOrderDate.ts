// `Order.orderDate` is a DateTime column. Manually-entered orders go through
// a real `datetime-local` input (see OrderForm.tsx) and always carry a
// genuine local time. Bulk-imported orders can carry a bare "YYYY-MM-DD"
// source date with no time at all, which `new Date(...)` parses as UTC
// midnight -- and neither a UTC-based nor a local-based check on the
// resulting Date object can reliably tell that apart from a genuine local
// midnight without shifting some case to the wrong calendar day (timezone
// math is inherently ambiguous once you're back to just a Date object).
// So detection happens on the RAW STRING before any parsing/timezone
// conversion: a literal "T00:00:00" (a synthetic stamp, ignoring optional
// milliseconds/zone suffix) means no real time was ever supplied.
const SYNTHETIC_MIDNIGHT = /T00:00:00(\.0+)?Z?$/;

export function formatOrderDate(value: string | Date, opts?: { dateOnly?: boolean }): string {
  const raw = typeof value === 'string' ? value : value.toISOString();
  const hasTime = !SYNTHETIC_MIDNIGHT.test(raw);
  const d = typeof value === 'string' ? new Date(value) : value;

  // A date-only value was parsed as UTC midnight from a bare "YYYY-MM-DD"
  // string with no timezone-relative meaning of its own -- extract via UTC
  // getters to get the original calendar date back exactly, not a local
  // conversion of an instant that was never really "midnight anywhere".
  if (!hasTime) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  const datePart = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  if (opts?.dateOnly) return datePart;
  const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  return `${datePart} ${timePart}`;
}
