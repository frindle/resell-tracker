// Pure parser for an Amazon product/offer page's buy-box. Reads the
// "Ships from" / "Sold by" merchants and the offer price so the BFMR
// auto-buy gate can refuse any offer NOT sold AND shipped by Amazon.com.
// No DOM, no network -- a string in, a plain object out.

export interface AmazonBuyBox {
  soldBy: string | null;
  shippedBy: string | null;
  soldAndShippedByAmazon: boolean;
  price: number | null;
  currency: string | null;
}

function clean(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseAmazonBuyBox(html: string): AmazonBuyBox {
  const out: AmazonBuyBox = { soldBy: null, shippedBy: null, soldAndShippedByAmazon: false, price: null, currency: null };

  // Modern tabular buy-box rows (attribute-tagged), e.g.
  // <div ... tabular-attribute-name="Sold by"><span>ACME Deals LLC</span></div>
  const attr = (label: string): string | null => {
    const m = html.match(new RegExp('tabular-attribute-name="' + label + '"[^>]*>([\\s\\S]*?)</div>', 'i'));
    return m ? clean(m[1]) : null;
  };

  // Legacy combined phrase: "Ships from and sold by Amazon.com." The merchant
  // name may contain a dot, so dotted segments stay in the capture.
  const text = clean(html);
  const combined = text.match(/ships\s+from\s+and\s+sold\s+by\s+([^.<\s][^.<]*(?:\.[^.<\s]+)*)/i);

  out.shippedBy = attr('Ships from') ?? (combined ? clean(combined[1]) : null);
  out.soldBy = attr('Sold by') ?? (combined ? clean(combined[1]) : null);
  // Only "Amazon.com" qualifies -- "Amazon Warehouse" or a marketplace seller does not.
  out.soldAndShippedByAmazon = /^amazon\.com\b/i.test(out.soldBy ?? '') && /^amazon\.com\b/i.test(out.shippedBy ?? '');

  // First "$1,234.56"-style amount (commas stripped) is the offer price.
  const priceM = html.replace(/<[^>]*>/g, ' ').match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/);
  if (priceM) {
    const n = parseFloat(priceM[1].replace(/,/g, ''));
    out.price = Number.isNaN(n) ? null : n;
    out.currency = out.price === null ? null : 'USD';
  }

  return out;
}
