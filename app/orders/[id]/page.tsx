import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import OrderDetailShell from '@/components/OrderDetailShell';
import OrderAttachments from '@/components/OrderAttachments';
import EgiftLink from '@/components/EgiftLink';
import MgcpLinks from '@/components/MgcpLinks';
import GiftCards from '@/components/GiftCards';
import CostcoReceiptLinker from '@/components/CostcoReceiptLinker';
import ReturnPanel from '@/components/ReturnPanel';
import BgCommitmentLinker from '@/components/BgCommitmentLinker';
import BigSkyCommitmentLinker from '@/components/BigSkyCommitmentLinker';
import BfmrReservationLinker from '@/components/BfmrReservationLinker';
import PaymentInfo from '@/components/PaymentInfo';
import QuarantineBanner from '@/components/QuarantineBanner';
import BelowCostBanner from '@/components/BelowCostBanner';
import { merchantUrl } from '@/lib/merchantUrl';
import { loadPendingLookups } from '@/lib/pendingLookupsDb';

export const dynamic = 'force-dynamic';


export default async function EditOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  const order = await prisma.order.findUnique({ where: { id: parseInt(id) }, include: { buyer: { select: { name: true } }, giftCards: { select: { value: true, ccSubmittedAt: true } } } });
  if (!order) notFound();
  const isCardCenter = /cardcenter/i.test(order.buyer?.name ?? '');
  const isBuyingGroup = /buying\s*group/i.test(order.buyer?.name ?? '');
  const isBfmr = /bfmr/i.test(order.buyer?.name ?? '');
  const isBigSky = /big\s*sky/i.test(order.buyer?.name ?? '');
  const rejectedItems = order.bfmrRejectedItems ? JSON.parse(order.bfmrRejectedItems) as { name: string; reason: string }[] : null;

  const pendingLookup = (await loadPendingLookups(order.userId, [order])).get(order.id) ?? null;
  const url = merchantUrl(order.platform, order.orderNumber, order.sourceUrl);

  return (
    <div className="space-y-6">
      {order.blockedAddressPattern && (
        <QuarantineBanner orderId={order.id} pattern={order.blockedAddressPattern} />
      )}
      {order.belowCostAlert && !order.cancelled && (
        <BelowCostBanner orderId={order.id} text={order.belowCostAlert} />
      )}
      {order.cancelled && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3">
          <p className="text-sm text-gray-400">This order has been cancelled.</p>
        </div>
      )}
      {order.locked && !order.cancelled && (
        <div className="bg-amber-950/40 border border-amber-800 rounded-lg px-4 py-3">
          <p className="text-sm text-amber-300">This order is locked. Unlock it to make changes.</p>
        </div>
      )}
      {rejectedItems && rejectedItems.length > 0 && (
        <div className="bg-red-950/40 border border-red-800 rounded-lg p-4 space-y-1">
          <p className="text-sm font-medium text-red-300">⚠ BFMR Rejected Items</p>
          {rejectedItems.map((item, i) => (
            <p key={i} className="text-xs text-red-400">{item.name}: {item.reason}</p>
          ))}
        </div>
      )}
      {/* Always rendered: recording a partial return (N of M units on a line)
          has to be reachable BEFORE anything has flagged the order as a
          return, which is why order 832's returned unit had nowhere to go. */}
      <ReturnPanel orderId={order.id} locked={order.locked} />
      <OrderDetailShell
        returnTo={from}
        orderId={order.id}
        locked={order.locked}
        cancelled={order.cancelled}
        platform={order.platform}
        merchantUrl={url}
        pendingLookup={pendingLookup}
        titleDescription={order.itemDescription || `Order #${order.id}`}
        initialData={{
          ...order,
          orderDate: order.orderDate.toISOString(),
          salePriceSynced: order.salePriceSynced,
          overdueAt: order.overdueAt?.toISOString() ?? null,
          deliveryDeadline: order.deliveryDeadline?.toISOString() ?? null,
          lost: order.lost,
          insuranceCost: order.insuranceCost,
          groupReferenceId: order.groupReferenceId ?? null,
          trackingValues: order.trackingValues ?? null,
          updatedAt: order.updatedAt.toISOString(),
          giftCards: order.giftCards.map(c => ({ value: c.value, ccSubmittedAt: c.ccSubmittedAt?.toISOString() ?? null })),
        }}
      />
      <div className="border-t border-gray-800 pt-6 space-y-6">
        <OrderAttachments orderId={order.id} />
        {/* Costco eGift delivery links only exist for Costco gift-card orders sold to CardCenter. */}
        {isCardCenter && order.platform.toLowerCase() === 'costco' && <EgiftLink orderId={order.id} />}
        {/* MyGiftCardsPlus card links: one link per card, scraped by the sidecar. */}
        {isCardCenter && order.platform.toLowerCase() === 'mgcp' && <MgcpLinks orderId={order.id} />}
        <CostcoReceiptLinker orderId={order.id} orderDate={order.orderDate.toISOString()} />
      </div>
      {isCardCenter && (
        <div className="border-t border-gray-800 pt-6">
          <GiftCards orderId={order.id} />
        </div>
      )}
      {isBuyingGroup && <BgCommitmentLinker orderId={order.id} itemDescription={order.itemDescription} />}
      {isBigSky && <BigSkyCommitmentLinker orderId={order.id} itemDescription={order.itemDescription} />}
      {isBfmr && <BfmrReservationLinker orderId={order.id} trackingNumbers={order.trackingNumbers} itemDescription={order.itemDescription} />}
      <PaymentInfo orderId={order.id} />
    </div>
  );
}
