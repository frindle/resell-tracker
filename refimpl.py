#!/usr/bin/env python3
"""Reference impl for rt-amazon-buybox. Overwrites the tracked stub; revert restores it."""
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/amazonOffer.ts'

IMPL = r'''// Pure parser for an Amazon product/offer page's buy-box.
// Reads the "Ships from" / "Sold by" merchants and the price so the BFMR
// auto-buy gate can refuse any offer NOT sold AND shipped by Amazon.com.
// No DOM, no network -- takes the scraped HTML/text string.

export interface AmazonBuyBox {
  soldBy: string | null;
  shippedBy: string | null;
  soldAndShippedByAmazon: boolean;
  price: number | null;
  currency: string | null;
}

// A merchant counts as Amazon ONLY when its name is Amazon.com (optionally
// "Amazon.com Services LLC" etc.). "Amazon Warehouse" (used goods) and any
// marketplace seller do NOT qualify -- the gate must stay firm.
function isAmazonMerchant(name: string | null): boolean {
  if (!name) return false;
  return /^amazon\.com\b/i.test(name.trim());
}

function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

export function parseAmazonBuyBox(html: string): AmazonBuyBox {
  const out: AmazonBuyBox = { soldBy: null, shippedBy: null, soldAndShippedByAmazon: false, price: null, currency: null };
  if (typeof html !== 'string' || html.length === 0) return out;

  // 1) Modern tabular buy-box: attribute-tagged rows.
  const attr = (label: string): string | null => {
    const re = new RegExp('tabular-attribute-name="' + label + '"[^>]*>([\\s\\S]*?)</div>', 'i');
    const m = html.match(re);
    return m ? clean(m[1]) : null;
  };
  out.shippedBy = attr('Ships from');
  out.soldBy = attr('Sold by');

  // 2) Legacy combined merchant-info phrase, e.g. "Ships from and sold by Amazon.com."
  if (!out.soldBy && !out.shippedBy) {
    const text = clean(html) ?? '';
    const combined = text.match(/ships\s+from\s+and\s+sold\s+by\s+([^.<]+)/i);
    if (combined) {
      const who = clean(combined[1]);
      out.soldBy = who;
      out.shippedBy = who;
    } else {
      const soldM = text.match(/sold\s+by[:\s]+([^.<|]+?)(?:ships\s+from|$)/i);
      const shipM = text.match(/ships\s+from[:\s]+([^.<|]+?)(?:sold\s+by|$)/i);
      if (soldM) out.soldBy = clean(soldM[1]);
      if (shipM) out.shippedBy = clean(shipM[1]);
    }
  }

  out.soldAndShippedByAmazon = isAmazonMerchant(out.soldBy) && isAmazonMerchant(out.shippedBy);

  // 3) Price: first "$1,234.56"-style amount (a-offscreen or plain text).
  const priceM = html.replace(/<[^>]*>/g, ' ').match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/);
  if (priceM) {
    const n = parseFloat(priceM[1].replace(/,/g, ''));
    if (!Number.isNaN(n)) { out.price = n; out.currency = 'USD'; }
  }

  return out;
}
'''
p.write_text(IMPL)
assert 'parseAmazonBuyBox' in IMPL and 'soldAndShippedByAmazon' in IMPL
print("refimpl applied")
