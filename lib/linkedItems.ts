// What linking an order to a buying-group reservation or commitment fills in
// on the order. Pure, so it can be tested without a database.
//
// The email gives a category ("Wearable Technology (3 items)") or a short
// retailer title; the reservation or commitment names the actual product, so
// once an order is linked its item description becomes the linked titles.
// A description the person typed (userEditedFields) is never replaced. The
// buyer is filled in only when the order has none and every link is with the
// same group.

export type LinkGroup = 'BFMR' | 'BuyingGroup' | 'BigSkyBuyers';

export type LinkedTitle = { group: LinkGroup; title: string | null | undefined; quantity: number };

export type OrderLinkState = {
  itemDescription: string | null;
  buyerId: number | null;
  userEditedFields: readonly string[];
  locked: boolean;
  cancelled: boolean;
};

/** Distinct titles in link order, "×N" when more than one unit, joined with " + ". */
export function combineLinkedTitles(links: readonly LinkedTitle[]): string | null {
  const byTitle = new Map<string, { title: string; qty: number }>();
  for (const l of links) {
    const title = String(l.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    const cur = byTitle.get(key);
    if (cur) cur.qty += Math.max(1, l.quantity || 1);
    else byTitle.set(key, { title, qty: Math.max(1, l.quantity || 1) });
  }
  if (byTitle.size === 0) return null;
  return [...byTitle.values()].map(t => (t.qty > 1 ? `${t.title} ×${t.qty}` : t.title)).join(' + ');
}

export function planLinkedSync(
  order: OrderLinkState,
  links: readonly LinkedTitle[],
  buyerIdFor: (group: LinkGroup) => number | null,
  opts: { keepItem?: boolean } = {},
): { itemDescription?: string; buyerId?: number } {
  if (order.locked || order.cancelled || links.length === 0) return {};
  const out: { itemDescription?: string; buyerId?: number } = {};
  if (!opts.keepItem && !order.userEditedFields.includes('itemDescription')) {
    const desc = combineLinkedTitles(links);
    if (desc && desc !== order.itemDescription) out.itemDescription = desc;
  }
  if (order.buyerId == null) {
    const groups = new Set(links.map(l => l.group));
    if (groups.size === 1) {
      const id = buyerIdFor([...groups][0]);
      if (id != null) out.buyerId = id;
    }
  }
  return out;
}
