import PDFDocument from 'pdfkit';

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generateReceiptHtml(receipt: ReceiptData): string {
  const items = receipt.itemArray ?? [];
  const tenders = receipt.tenderArray ?? [];

  const rows = items.map(item => {
    const desc = esc(item.itemDescription01 ?? item.itemNumber ?? '');
    const desc2 = item.itemDescription02 ? `<div class="sub">${esc(item.itemDescription02)}</div>` : '';
    const multiQty = (item.unit != null && item.unit > 1 && item.itemUnitPriceAmount != null)
      ? `<div class="sub">${item.unit} @ ${fmt(item.itemUnitPriceAmount)}</div>` : '';
    const amt = item.amount != null ? fmt(item.amount) : '';
    return `<tr><td><b>${desc}</b>${desc2}${multiQty}</td><td class="r">${amt}</td></tr>`;
  }).join('');

  const tenderRows = tenders.map(t =>
    `<tr><td>${esc(t.tenderDescription ?? '')}</td><td class="r">${t.amountTender != null ? fmt(t.amountTender) : ''}</td></tr>`
  ).join('');

  const addr = [receipt.warehouseAddress1, receipt.warehouseAddress2,
    receipt.warehouseCity && receipt.warehouseState
      ? `${receipt.warehouseCity}, ${receipt.warehouseState} ${receipt.warehousePostalCode ?? ''}`.trim()
      : null,
  ].filter(Boolean).map(l => `<div>${esc(l!)}</div>`).join('');

  const txInfo = [
    receipt.registerNumber != null ? `REG# ${String(receipt.registerNumber).padStart(2, '0')}` : '',
    receipt.operatorNumber != null ? `OP# ${String(receipt.operatorNumber).padStart(3, '0')}` : '',
    receipt.transactionNumber != null ? `TE# ${String(receipt.transactionNumber).padStart(3, '0')}` : '',
  ].filter(Boolean).join('  ');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Costco Receipt ${esc(receipt.transactionBarcode)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f5f5f5;display:flex;justify-content:center;padding:24px;font-family:monospace}
.receipt{background:#fff;width:320px;padding:16px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:12px;color:#111}
.c{text-align:center}
.hdr{font-weight:bold;font-size:14px;margin-bottom:4px}
hr{border:none;border-top:1px dashed #999;margin:8px 0}
table{width:100%;border-collapse:collapse}
td{vertical-align:top;padding:2px 0}
td.r{text-align:right;white-space:nowrap;padding-left:8px;width:60px}
.sub{font-size:10px;color:#555;padding-left:8px}
.total-row td{font-weight:bold;padding-top:4px}
.barcode{margin-top:8px;font-size:10px;letter-spacing:1px}
</style></head><body><div class="receipt">
<div class="c hdr">COSTCO WHOLESALE</div>
<div class="c">${esc(receipt.warehouseName)}</div>
${addr ? `<div class="c" style="font-size:10px;color:#555">${addr}</div>` : ''}
${txInfo ? `<div class="c" style="font-size:10px;margin-top:4px">${esc(txInfo)}</div>` : ''}
${receipt.transactionDateTime ? `<div class="c" style="font-size:10px">${esc(fmtDateTime(receipt.transactionDateTime))}</div>` : ''}
<hr>
<table>${rows}</table>
<hr>
<table>
${receipt.subTotal != null ? `<tr><td>SUBTOTAL</td><td class="r">${fmt(receipt.subTotal)}</td></tr>` : ''}
${receipt.instantSavings ? `<tr><td>INSTANT SAVINGS</td><td class="r">-${fmt(receipt.instantSavings)}</td></tr>` : ''}
${receipt.taxes != null ? `<tr><td>TAX</td><td class="r">${fmt(receipt.taxes)}</td></tr>` : ''}
<tr class="total-row"><td>TOTAL</td><td class="r">${fmt(receipt.total)}</td></tr>
</table>
<hr>
<table>${tenderRows}</table>
${receipt.membershipNumber ? `<hr><div class="c" style="font-size:10px">MEMBER# ${esc(String(receipt.membershipNumber))}</div>` : ''}
<div class="c barcode">${esc(receipt.transactionBarcode)}</div>
</div></body></html>`;
}

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
