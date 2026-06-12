import PDFDocument from 'pdfkit';

export interface ReceiptItem {
  itemNumber: string;
  itemDescription01?: string | null;
  itemDescription02?: string | null;
  unit?: number | null;
  amount?: number | null;
  itemUnitPriceAmount?: number | null;
  taxFlag?: string | null;
}

export interface ReceiptTender {
  tenderDescription?: string | null;
  amountTender?: number | null;
}

export interface ReceiptData {
  warehouseName: string;
  warehouseAddress1?: string | null;
  warehouseAddress2?: string | null;
  warehouseCity?: string | null;
  warehouseState?: string | null;
  warehousePostalCode?: string | null;
  transactionDate?: string | null;
  transactionDateTime?: string | null;
  registerNumber?: number | null;
  operatorNumber?: number | null;
  transactionNumber?: number | null;
  transactionBarcode: string;
  subTotal?: number | null;
  taxes?: number | null;
  instantSavings?: number | null;
  total: number;
  membershipNumber?: string | number | null;
  itemArray?: ReceiptItem[];
  tenderArray?: ReceiptTender[];
  couponArray?: { upcnumberCoupon?: string }[];
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function fmtDateTime(dt: string | null | undefined): string {
  if (!dt) return '';
  try {
    const d = new Date(dt);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(2);
    let h = d.getHours();
    const min = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${mm}/${dd}/${yy} ${h}:${min} ${ampm}`;
  } catch {
    return dt;
  }
}

export function generateReceiptPdf(receipt: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // 288pt = 4 inches wide (thermal receipt width)
    const pageWidth = 288;
    const margin = 14;
    const contentWidth = pageWidth - margin * 2;

    // Compute dynamic height
    const items = receipt.itemArray ?? [];
    const tenders = receipt.tenderArray ?? [];
    const baseHeight = 280 + items.length * 28 + tenders.length * 20;

    const doc = new PDFDocument({
      size: [pageWidth, Math.max(baseHeight, 400)],
      margin,
      font: 'Courier',
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const bold = 'Courier-Bold';
    const regular = 'Courier';
    const small = 7;
    const normal = 8;
    const large = 10;
    const center = { align: 'center' as const };
    const right = { align: 'right' as const };

    let y = margin;

    function text(str: string, opts?: PDFKit.Mixins.TextOptions, size = normal, font = regular) {
      doc.font(font).fontSize(size).text(str, margin, y, { width: contentWidth, ...opts });
      y = doc.y + 2;
    }

    function rule() {
      doc.moveTo(margin, y).lineTo(margin + contentWidth, y).lineWidth(0.5).stroke();
      y += 4;
    }

    function row(left: string, right: string, size = normal, font = regular) {
      const rWidth = 50;
      doc.font(font).fontSize(size)
        .text(left, margin, y, { width: contentWidth - rWidth })
        .text(right, margin, y, { width: contentWidth, align: 'right' });
      y = doc.y + 2;
    }

    // Header
    text('COSTCO WHOLESALE', center, large, bold);
    if (receipt.warehouseAddress1) text(receipt.warehouseAddress1, center, small);
    if (receipt.warehouseCity && receipt.warehouseState) {
      text(`${receipt.warehouseCity}, ${receipt.warehouseState} ${receipt.warehousePostalCode ?? ''}`.trim(), center, small);
    }
    y += 4;

    // Transaction info
    const reg = receipt.registerNumber != null ? `REG# ${String(receipt.registerNumber).padStart(2, '0')}` : '';
    const op = receipt.operatorNumber != null ? `OP# ${String(receipt.operatorNumber).padStart(3, '0')}` : '';
    const trn = receipt.transactionNumber != null ? `TE# ${String(receipt.transactionNumber).padStart(3, '0')}` : '';
    text([reg, op, trn].filter(Boolean).join('  '), center, small);
    text(fmtDateTime(receipt.transactionDateTime), center, small);
    y += 4;
    rule();

    // Items
    for (const item of items) {
      const desc = item.itemDescription01 ?? item.itemNumber;
      const amount = item.amount ?? 0;
      const hasMultiQty = item.unit != null && item.unit > 1;

      row(desc.slice(0, 22), fmt(amount), normal, bold);

      if (item.itemDescription02) {
        text(`  ${item.itemDescription02}`, {}, small);
      }
      if (hasMultiQty && item.itemUnitPriceAmount != null) {
        text(`  ${item.unit} @ ${fmt(item.itemUnitPriceAmount)}`, {}, small);
      }
    }

    rule();

    // Totals
    if (receipt.subTotal != null) row('SUBTOTAL', fmt(receipt.subTotal));
    if (receipt.instantSavings && receipt.instantSavings !== 0) row('INSTANT SAVINGS', `-${fmt(receipt.instantSavings)}`);
    if (receipt.taxes != null) row('TAX', fmt(receipt.taxes));
    y += 2;
    row('TOTAL', fmt(receipt.total), normal, bold);
    y += 4;
    rule();

    // Tenders
    for (const tender of tenders) {
      if (!tender.tenderDescription) continue;
      row(tender.tenderDescription.toUpperCase(), fmt(tender.amountTender ?? 0));
      text('  APPROVED - PURCHASE', {}, small);
    }

    y += 4;
    rule();

    // Member number
    if (receipt.membershipNumber) {
      text(`MEMBER# ${receipt.membershipNumber}`, center, small);
    }
    text(receipt.transactionBarcode, center, small);

    doc.end();
  });
}
