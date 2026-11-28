// What the "Accept" buttons of an open bank row offer, and how a typed order reference becomes a link request.
// Pure, so the table row and the review card share one list (and the keyboard can pick the nth option).

export type Suggestion =
  | { kind: 'transfer'; txnId: number } | { kind: 'order'; orderIds: number[] }
  | { kind: 'split'; orderId: number; subsets: number[][]; amounts: Record<string, number> }
  | { kind: 'refund'; returns: { returnId: number; orderId: number; partial?: boolean }[] }
  | { kind: 'pair'; txnId: number }
  | { kind: 'cashback'; portal: boolean; options: { aggregate: boolean; units: { orderId: number; cents: number }[] }[] }
  | { kind: 'deposit'; buyerId: number | null; aliased: boolean; options: { how: string; parts: { orderId: number; cents: number }[]; totalCents: number; shortfallCents: number }[] };

export type AcceptOption = { key: string; label: string; body: Record<string, unknown> };

/** One entry per Accept button, in the order the row shows them. `fmt` formats cents (the page passes its money()). */
export function acceptOptions(sg: Suggestion | null | undefined, fmt: (cents: number) => string): AcceptOption[] {
  if (!sg) return [];
  const plain = { action: 'accept' };
  switch (sg.kind) {
    case 'order':
      return sg.orderIds.length > 1
        ? sg.orderIds.map(o => ({ key: `o${o}`, label: `Accept #${o}`, body: { action: 'accept', orderId: o } }))
        : [{ key: 'one', label: 'Accept', body: plain }];
    case 'split':
      return sg.subsets.map((sub, i) => ({
        key: `s${i}`, label: `Accept ${sub.length} charges (${fmt(sub.reduce((x, id) => x + (sg.amounts[String(id)] ?? 0), 0))})`, body: { action: 'accept', txnIds: sub },
      }));
    case 'refund':
      return sg.returns.length > 1
        ? sg.returns.map(r => ({ key: `r${r.returnId}`, label: `Accept return #${r.returnId}`, body: { action: 'accept', returnId: r.returnId } }))
        : [{ key: 'one', label: 'Accept', body: plain }];
    case 'cashback':
      return sg.options.length > 1
        ? sg.options.map(o => ({ key: `c${o.units[0].orderId}`, label: `Accept #${o.units[0].orderId}`, body: { action: 'accept', orderId: o.units[0].orderId } }))
        : [{ key: 'one', label: `Accept${sg.options[0].aggregate ? ` ${sg.options[0].units.length} orders` : ''}`, body: plain }];
    case 'deposit':
      return sg.options.length > 1
        ? sg.options.map((o, i) => ({ key: `d${i}`, label: `Accept ${o.parts.map(p => `#${p.orderId}`).join('+')}`, body: { action: 'accept', orderIds: o.parts.map(p => p.orderId) } }))
        : [{ key: 'one', label: `Accept ${sg.options[0].parts.length} order${sg.options[0].parts.length === 1 ? '' : 's'}`, body: plain }];
    case 'transfer': case 'pair':
      return [{ key: 'one', label: 'Accept', body: plain }];
  }
}

/** "#12" is an order id, "r#7" a return id, "t#407" a bank row to pair as a transfer, anything else an order number. */
export function linkBody(v: string): Record<string, unknown> {
  const x = v.trim();
  const tr = /^t#(\d+)$/i.exec(x); if (tr) return { action: 'transfer', partnerId: Number(tr[1]) };
  const r = /^r#(\d+)$/i.exec(x); if (r) return { action: 'link', returnId: Number(r[1]) };
  const o = /^#(\d+)$/.exec(x); if (o) return { action: 'link', orderId: Number(o[1]) };
  return { action: 'link', orderNumber: x };
}
