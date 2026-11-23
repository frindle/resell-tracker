// The database half of a BuyingGroup commitment price change (the pure half,
// with the rules, is lib/bgPriceChange.ts). Both the commitment sync and the
// "Commitment Price Change Scheduled" email land here, so an order's sale
// price follows its commitment whichever of them sees the change first.
import { prisma, getSetting } from '@/lib/db';
import { sendPushover } from '@/lib/pushover';
import { recalcSalePrice } from '@/lib/commitmentSalePrice';
import { returnedUnitsByLine } from '@/lib/orderReturns';
import { orderPnl } from '@/lib/orderPnl';
import { addLine } from '@/lib/orderNotes';
import {
  repriceSkip, belowCostBy, previewSale, alertChange, alertText, priceNoteLine, priceChangeText, anyUnderCost,
  type PriceTerms, type RepriceResult,
} from '@/lib/bgPriceChange';

const ORDER_FIELDS = {
  id: true, salePrice: true, cost: true, shippingCost: true, insuranceCost: true, returnedCost: true,
  cashbackAmount: true, portalCashback: true, amexOfferDollars: true, memberReward: true,
  locked: true, cancelled: true, salePriceSynced: true, bgCredited: true, bgPaidAmount: true,
  notes: true, belowCostAlert: true,
} as const;

async function linkedOrders(commitmentDbId: number) {
  const links = await prisma.orderCommitmentLink.findMany({
    where: { commitmentId: commitmentDbId },
    select: { id: true, orderId: true, quantity: true },
  });
  const ids = [...new Set(links.map(l => l.orderId))];
  const orders = ids.length
    ? await prisma.order.findMany({ where: { id: { in: ids } }, select: ORDER_FIELDS, orderBy: { id: 'asc' } })
    : [];
  return { links, orders };
}

const moved = (r: RepriceResult) => r.oldSale != null && r.newSale != null ? Math.abs(r.newSale - r.oldSale) > 0.005 : r.newSale != null;

/**
 * Re-price every order linked to the commitment from its current price (the
 * caller has already written it), note the change on each order that moved,
 * and set or clear the below-cost flag. Paid, credited, cancelled and locked
 * orders are left as they are and reported as skipped.
 */
export async function repriceCommitmentOrders(commitmentDbId: number, commitmentId: string, to: PriceTerms, day: string): Promise<RepriceResult[]> {
  const { orders } = await linkedOrders(commitmentDbId);
  const out: RepriceResult[] = [];
  for (const o of orders) {
    const skip = repriceSkip(o);
    if (skip) {
      out.push({ orderId: o.id, skip, oldSale: o.salePrice, newSale: null, under: 0, credits: 0 });
      continue;
    }
    const newSale = await recalcSalePrice(o.id);
    const after = { ...o, salePrice: newSale };
    const res: RepriceResult = { orderId: o.id, skip: null, oldSale: o.salePrice, newSale, under: belowCostBy(after), credits: orderPnl(after).credits };
    out.push(res);
    const data: { notes?: string; belowCostAlert?: string | null } = {};
    if (moved(res)) data.notes = addLine(o.notes, priceNoteLine(commitmentId, day, to, res));
    const flag = alertChange(res, !!o.belowCostAlert);
    if (flag === 'set') data.belowCostAlert = alertText(commitmentId, day, res);
    else if (flag === 'clear') data.belowCostAlert = null;
    if (Object.keys(data).length) await prisma.order.updateMany({ where: { id: o.id, locked: false }, data });
  }
  console.log(`[bg-price] ${commitmentId} repriced=${out.filter(moved).length} skipped=${out.filter(r => r.skip).length} under=${out.filter(r => r.under > 0).length}`);
  return out;
}

/** What a change that hasn't happened yet will do to the linked orders. Writes nothing. */
export async function previewCommitmentReprice(commitmentDbId: number, from: PriceTerms, to: PriceTerms): Promise<RepriceResult[]> {
  const { links, orders } = await linkedOrders(commitmentDbId);
  const out: RepriceResult[] = [];
  for (const o of orders) {
    const skip = repriceSkip(o);
    if (skip) {
      out.push({ orderId: o.id, skip, oldSale: o.salePrice, newSale: null, under: 0, credits: 0 });
      continue;
    }
    const returned = await returnedUnitsByLine(o.id);
    const sold = links.filter(l => l.orderId === o.id).reduce((n, l) => n + Math.max(0, l.quantity - (returned.get(`commit:${l.id}`) ?? 0)), 0);
    const newSale = previewSale(o.salePrice, sold, from, to);
    const after = { ...o, salePrice: newSale };
    out.push({ orderId: o.id, skip: null, oldSale: o.salePrice, newSale, under: belowCostBy(after), credits: orderPnl(after).credits });
  }
  return out;
}

/** Whether a re-price is worth a Pushover: something moved, went under cost, or is locked against the change. */
export function worthTelling(results: readonly RepriceResult[]): boolean {
  return results.some(r => moved(r) || r.under > 0 || r.skip === 'locked');
}

export async function notifyPriceChange(
  uid: number, commitmentId: string, from: PriceTerms | null, to: PriceTerms, when: string,
  results: readonly RepriceResult[], scheduled: boolean,
): Promise<void> {
  const [key, token] = await Promise.all([getSetting(uid, 'pushover_user_key'), getSetting(uid, 'pushover_app_token')]);
  if (!key?.value || !token?.value) return;
  const title = anyUnderCost(results) ? 'BuyingGroup price change: below cost' : 'BuyingGroup price change';
  await sendPushover(key.value, token.value, priceChangeText(commitmentId, from, to, when, results, scheduled), title)
    .catch(e => console.error('[bg-price] pushover failed:', String(e).slice(0, 160)));
}
