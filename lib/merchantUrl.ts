// The store's own page for an order, or null when there isn't one to link.
// Shared by the orders list, the order page and the BuyingGroup page so they
// always agree: before this the list linked only orders that arrived with a
// stored source URL (extension syncs), so Amazon and Walmart orders that came
// in by email, BFMR or BuyingGroup showed a grey number with no link.

export const COSTCO_CLIENT_ID = '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf';

export function merchantUrl(platform: string, orderNumber: string | null, sourceUrl: string | null = null): string | null {
  const p = (platform || '').trim().toLowerCase();
  const num = (orderNumber || '').trim().replace(/^#/, '');
  if (p === 'costco') {
    // Only online orders (synced by the extension) have a sourceUrl; in-store receipts have no order page.
    if (!num || !sourceUrl) return null;
    return `https://www.costco.com/myaccount/#/app/${COSTCO_CLIENT_ID}/orderdetails/${encodeURIComponent(num)}`;
  }
  if (sourceUrl) return sourceUrl;
  if (!num) return null;
  if (p === 'amazon') return `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(num)}`;
  // Walmart's order page takes the number without its hyphen.
  if (p === 'walmart') return `https://www.walmart.com/orders/${encodeURIComponent(num.replace(/-/g, ''))}`;
  return null;
}
