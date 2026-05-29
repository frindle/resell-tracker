export type ParsedOrder = {
  platform: 'Amazon' | 'Walmart';
  orderNumber: string;
  orderDate: string;       // ISO date string
  itemDescription: string;
  cost: number;
  shippingCost: number;
  shippingAddress: string; // raw address for blocked-address matching
};

// ---------------------------------------------------------------------------
// Generic CSV parser
// ---------------------------------------------------------------------------

export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]);
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = splitCSVLine(line);
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
  return parseFloat(val.replace(/[$,\s]/g, '')) || 0;
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
  if (set.has('asin') || set.has('product name') || set.has('website')) return 'amazon';
  if (set.has('grand total') || set.has('number of shipments') || set.has('invoice url')) return 'walmart';
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
// Amazon Privacy Central CSV  (Retail.OrderHistory.1.csv)
// Also compatible with Order History Exporter Firefox extension output
//
// Key columns: Order ID, Order Date, Product Name, Shipment Item Subtotal,
//              Shipping Charge, Total Charged, Shipping Address
// ---------------------------------------------------------------------------

export function parseAmazonCSV(text: string): ParsedOrder[] {
  const rows = parseCSV(text);
  return rows
    .filter(r => r['Order Status'] !== 'Cancelled')
    .map(r => ({
      platform: 'Amazon' as const,
      orderNumber: r['Order ID'] ?? '',
      orderDate: parseDate(r['Order Date'] ?? ''),
      itemDescription: r['Product Name'] ?? '',
      cost: parseMoney(r['Shipment Item Subtotal'] ?? r['Total Charged'] ?? '0'),
      shippingCost: parseMoney(r['Shipping Charge'] ?? '0'),
      shippingAddress: r['Shipping Address'] ?? '',
    }))
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
    .map(r => ({
      platform: 'Walmart' as const,
      orderNumber: r['Order ID'] ?? '',
      orderDate: parseDate(r['Order Date'] ?? ''),
      itemDescription: '',
      cost: parseMoney(r['Grand Total'] ?? r['Sub Total'] ?? '0'),
      shippingCost: parseMoney(r['Shipping & Handling Total'] ?? r['Shipping & Handling'] ?? '0'),
      shippingAddress: r['Shipping Address'] ?? r['Shipping Address Name'] ?? '',
    }))
    .filter(o => o.orderNumber);
}

// ---------------------------------------------------------------------------
// Auto-detect and parse
// ---------------------------------------------------------------------------

export function autoParseCSV(text: string): { platform: Platform; orders: ParsedOrder[] } {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? '';
  const headers = firstLine.split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const platform = detectPlatform(headers);

  if (platform === 'amazon') return { platform, orders: parseAmazonCSV(text) };
  if (platform === 'walmart') return { platform, orders: parseWalmartCSV(text) };
  return { platform: 'unknown', orders: [] };
}
