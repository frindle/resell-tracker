import { prisma } from '@/lib/db';
import { orderDigits, pickReturnRowForLabel } from '@/lib/walmartReturnLabel';
import type { ParsedEmailOrder } from '@/lib/emailMessage';

// Fills OrderReturn.returnTracking from Walmart return-label emails (lib/walmartReturnLabel.ts). Safe on
// every poll: a number already stored, or an ambiguous label, changes nothing. Logs counts only.
export async function applyWalmartReturnLabels(emails: readonly ParsedEmailOrder[]): Promise<{ seen: number; filled: number }> {
  let seen = 0;
  let filled = 0;
  for (const e of emails) {
    const label = e.returnLabel;
    if (!label) continue;
    seen++;
    const digits = orderDigits(label.orderNumber);
    if (digits.length < 8) continue;
    const orders = await prisma.order.findMany({
      where: { platform: 'Walmart', orderNumber: { contains: digits } },
      select: { id: true, orderNumber: true, returns: { select: { id: true, status: true, returnTracking: true } } },
    });
    const exact = orders.filter(o => orderDigits(o.orderNumber) === digits);
    if (exact.length !== 1) continue;
    const pick = pickReturnRowForLabel(exact[0].returns, label.trackingNumbers);
    if (!pick) continue;
    await prisma.orderReturn.update({ where: { id: pick.id }, data: { returnTracking: pick.tracking } });
    filled++;
  }
  if (seen) console.log(`[walmart-return-label] seen=${seen} filled=${filled}`);
  return { seen, filled };
}
