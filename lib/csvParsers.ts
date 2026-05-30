export type ParsedOrder = {
  platform: 'Amazon' | 'Walmart';
  orderNumber: string;
  orderDate: string;       // ISO date string
  itemDescription: string;
  cost: number;
  shippingCost: number;
  shippingAddress: string; // raw address for blocked-address matching
  sourceUrl: string;
};

// ---------------------------------------------------------------------------
// Generic CSV parser
// ---------------------------------------------------------------------------

export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Auto-detect delimiter: if the first line has more tabs than commas, treat as TSV
  const firstLine = lines[0];
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const delim = tabCount > commaCount ? '\t' : ',';

  const headers = delim === '\t' ? firstLine.split('\t') : splitCSVLine(firstLine);
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = delim === '\t' ? line.split('\t') : splitCSVLine(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h.trim()] = (vals[i] ?? '').trim(); });
      return row;
    });
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseMoney(val: string): number {
  // Strip currency symbols and whitespace, keep digits, period, comma, minus
  const cleaned = val.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return 0;
  // Both separators present: whichever comes last is the decimal separator
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      // European: 1.234,56
      return parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
    }
    // US: 1,234.56
    return parseFloat(cleaned.replace(/,/g, '')) || 0;
  }
  // Comma only — decimal if ≤2 digits follow (e.g. "25,99"), else thousands
  if (cleaned.includes(',') && !cleaned.includes('.')) {
    const parts = cleaned.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      return parseFloat(cleaned.replace(',', '.')) || 0;
    }
    return parseFloat(cleaned.replace(/,/g, '')) || 0;
  }
  return parseFloat(cleaned) || 0;
}

function parseDate(val: string): string {
  if (!val) return new Date().toISOString().split('T')[0];
  const d = new Date(val);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return val;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export type Platform = 'amazon' | 'walmart' | 'unknown';

export function detectPlatform(headers: string[]): Platform {
  const set = new Set(headers.map(h => h.toLowerCase().trim()));
  // Amazon Privacy Central export OR Firefox Order History Exporter extension
  if (set.has('asin') || set.has('item asin') || set.has('item title') || set.has('website')) return 'amazon';
  // Walmart: various exporter formats
  if (set.has('grand total') || set.has('number of shipments') || set.has('invoice url')) return 'walmart';
  // Walmart order history exporter (Order Number + Order Total columns)
  if (set.has('order number') && (set.has('order total') || set.has('subtotal'))) return 'walmart';
  // Amazon: "product name" is ambiguous — check after Walmart rules
  if (set.has('product name') && !set.has('order number')) return 'amazon';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Address blocking
// ---------------------------------------------------------------------------

export function isAddressBlocked(address: string, patterns: string[]): boolean {
  if (!address || patterns.length === 0) return false;
  const lower = address.toLowerCase();
  return patterns.some(p => p && lower.includes(p.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Amazon CSV — supports two formats:
//   1. Privacy Central export (Retail.OrderHistory.1.csv)
//      columns: Order ID, Order Date, Product Name, Shipment Item Subtotal,
//               Shipping Charge, Total Charged, Shipping Address, Order Status
//   2. Firefox Order History Exporter extension
//      columns: Order ID, Order Date, Item Title, Item ASIN, Item Price,
//               Total Amount, Status
// ---------------------------------------------------------------------------

export function parseAmazonCSV(text: string): ParsedOrder[] {
  const rows = parseCSV(text);
  return rows
    .filter(r => {
      const status = (r['Order Status'] ?? r['Status'] ?? '').toLowerCase();
      return !status.includes('cancel');
    })
    .map(r => {
      // Firefox extension: Total Amount = actual order total (after discounts/promotions).
      // Item Price = unit list price; multiply by quantity if needed.
      // Privacy Central: Shipment Item Subtotal is most accurate per-line cost.
      const itemPrice = parseMoney(r['Item Price'] ?? '0');
      const qty = parseInt(r['Item Quantity'] ?? '1', 10) || 1;
      const itemTotal = itemPrice * qty;
      const cost =
        parseMoney(r['Shipment Item Subtotal'] || '0') ||
        parseMoney(r['Total Amount'] || '0') ||
        itemTotal ||
        parseMoney(r['Total Charged'] || '0');

      return {
        platform: 'Amazon' as const,
        orderNumber: r['Order ID'] ?? '',
        orderDate: parseDate(r['Order Date'] ?? ''),
        itemDescription: r['Product Name'] ?? r['Item Title'] ?? '',
        cost,
        shippingCost: parseMoney(r['Shipping Charge'] ?? '0'),
        shippingAddress: r['Shipping Address'] ?? '',
        sourceUrl: r['Details URL'] ?? r['Item URL'] ?? '',
      };
    })
    .filter(o => o.orderNumber);
}

// ---------------------------------------------------------------------------
// Walmart extension CSV (Walmart Invoice Exporter / OrderPro)
//
// Key columns: Order ID, Order Date, Sub Total, Shipping & Handling Total,
//              Grand Total, Shipping Address
// ---------------------------------------------------------------------------

export function parseWalmartCSV(text: string): ParsedOrder[] {
  const rows = parseCSV(text);
  return rows
    .filter(r => !(r['Delivery Status'] ?? '').toLowerCase().includes('cancel'))
    .map(r => ({
      platform: 'Walmart' as const,
      orderNumber: r['Order ID'] ?? r['Order Number'] ?? '',
      orderDate: parseDate(r['Order Date'] ?? ''),
      itemDescription: r['Product Name'] ?? '',
      cost: parseMoney(r['Grand Total'] ?? r['Order Total'] ?? r['Sub Total'] ?? r['Subtotal'] ?? '0'),
      shippingCost: parseMoney(r['Shipping & Handling Total'] ?? r['Shipping & Handling'] ?? r['Delivery Charges'] ?? '0'),
      shippingAddress: r['Shipping Address'] ?? r['Shipping Address Name'] ?? '',
      sourceUrl: r['Invoice URL'] ?? r['Details URL'] ?? r['Product Link'] ?? '',
    }))
    .filter(o => o.orderNumber);
}

// ---------------------------------------------------------------------------
// Auto-detect and parse
// ---------------------------------------------------------------------------

export function autoParseCSV(text: string): { platform: Platform; orders: ParsedOrder[] } {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? '';
  // Use the same tab-vs-comma detection as parseCSV so TSV files are handled correctly
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const delim = tabCount > commaCount ? '\t' : ',';
  const headers = (delim === '\t' ? firstLine.split('\t') : splitCSVLine(firstLine))
    .map(h => h.replace(/^"|"$/g, '').trim());
  const platform = detectPlatform(headers);

  if (platform === 'amazon') return { platform, orders: parseAmazonCSV(text) };
  if (platform === 'walmart') return { platform, orders: parseWalmartCSV(text) };
  return { platform: 'unknown', orders: [] };
}
