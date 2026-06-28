import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import OrderForm from '@/components/OrderForm';
import OrderAttachments from '@/components/OrderAttachments';
import GiftCards from '@/components/GiftCards';
import CostcoReceiptLinker from '@/components/CostcoReceiptLinker';
import LockButton from '@/components/LockButton';
import ReturnPanel from '@/components/ReturnPanel';
import BgCommitmentLinker from '@/components/BgCommitmentLinker';
import BfmrReservationLinker from '@/components/BfmrReservationLinker';
import BfmrSubmitTracking from '@/components/BfmrSubmitTracking';
import PaymentInfo from '@/components/PaymentInfo';
import QuarantineBanner from '@/components/QuarantineBanner';

export const dynamic = 'force-dynamic';

const COSTCO_CLIENT_ID = '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf';

function merchantUrl(platform: string, orderNumber: string | null, sourceUrl: string | null): string | null {
  const p = platform.toLowerCase();
  if (p === 'costco') {
    // Only online orders (synced by extension) have sourceUrl — in-store receipt orders have no direct URL
    if (!orderNumber || !sourceUrl) return null;
    return `https://www.costco.com/myaccount/#/app/${COSTCO_CLIENT_ID}/orderdetails/${orderNumber}`;
  }
  if (sourceUrl) return sourceUrl;
  if (!orderNumber) return null;
  if (p === 'amazon') return `https://www.amazon.com/gp/your-account/order-details?orderID=${orderNumber}`;
  if (p === 'walmart') {
    const walmartNum = orderNumber.replace('-', '');
    return `https://www.walmart.com/orders/${walmartNum}`;
  }
  return null;
}

export default async function EditOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  const order = await prisma.order.findUnique({ where: { id: parseInt(id) }, include: { buyer: { select: { name: true } } } });
  if (!order) notFound();
  const isCardCenter = /cardcenter/i.test(order.buyer?.name ?? '');
  const isBuyingGroup = /buying\s*group/i.test(order.buyer?.name ?? '');
  const isBfmr = /bfmr/i.test(order.buyer?.name ?? '');
  const rejectedItems = order.bfmrRejectedItems ? JSON.parse(order.bfmrRejectedItems) as { name: string; reason: string }[] : null;

  const url = merchantUrl(order.platform, order.orderNumber, order.sourceUrl);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Edit Order</h1>
          <p className="text-gray-400 text-sm mt-1">{order.itemDescription || `Order #${order.id}`}</p>
        </div>
        <div className="flex flex-row items-center gap-2 shrink-0">
          <LockButton orderId={order.id} locked={order.locked} />
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap"
            >
              View on {order.platform} →
            </a>
          )}
        </div>
      </div>
      {order.blockedAddressPattern && (
        <QuarantineBanner orderId={order.id} pattern={order.blockedAddressPattern} />
      )}
      {order.locked && (
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
      {(order.returnStatus || (rejectedItems && rejectedItems.length > 0)) && (
        <ReturnPanel
          orderId={order.id}
          returnStatus={order.returnStatus}
          returnTracking={order.returnTracking}
          locked={order.locked}
        />
      )}
      <OrderForm returnTo={from} initialData={{
        ...order,
        orderDate: order.orderDate.toISOString(),
        salePriceSynced: order.salePriceSynced,
        overdueAt: order.overdueAt?.toISOString() ?? null,
        lost: order.lost,
        insuranceCost: order.insuranceCost,
        groupReferenceId: order.groupReferenceId ?? null,
        trackingValues: order.trackingValues ?? null,
      }} />
      <div className="border-t border-gray-800 pt-6 space-y-6">
        <OrderAttachments orderId={order.id} />
        <CostcoReceiptLinker orderId={order.id} orderDate={order.orderDate.toISOString()} />
      </div>
      {isCardCenter && (
        <div className="border-t border-gray-800 pt-6">
          <GiftCards orderId={order.id} />
        </div>
      )}
      {isBuyingGroup && <BgCommitmentLinker orderId={order.id} />}
      {isBfmr && <BfmrReservationLinker orderId={order.id} trackingNumbers={order.trackingNumbers} />}
      {isBfmr && process.env.BFMR_SUBMIT_UI_ENABLED === 'true' && (
        <BfmrSubmitTracking orderId={order.id} trackingNumbers={order.trackingNumbers} />
      )}
      <PaymentInfo orderId={order.id} />
    </div>
  );
}
