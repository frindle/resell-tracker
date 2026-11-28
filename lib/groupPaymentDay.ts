// Pure helpers for stored group payments (no database import, so plain tests can load them).

/** The day a payment was made: its receivedOn, else the date inside a name like "P1056-20260709". null when neither is usable. */
export function paymentDay(receivedOn: string | null | undefined, name: string): string | null {
  const iso = receivedOn?.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const m = name.match(/^P\d+-(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** The buyer most of the orders belong to (ties: the lowest id); null when none has a buyer. */
export function commonBuyerId(buyerIds: (number | null)[]): number | null {
  const n = new Map<number, number>();
  for (const b of buyerIds) if (b != null) n.set(b, (n.get(b) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}
