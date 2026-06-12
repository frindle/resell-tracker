import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import OrderForm from '@/components/OrderForm';
import OrderAttachments from '@/components/OrderAttachments';
import GiftCards from '@/components/GiftCards';

export const dynamic = 'force-dynamic';

function merchantUrl(platform: string, orderNumber: string | null, sourceUrl: string | null): string | null {
  if (sourceUrl) return sourceUrl;
  if (!orderNumber) return null;
  const p = platform.toLowerCase();
  if (p === 'amazon') return `https://www.amazon.com/gp/your-account/order-details?orderID=${orderNumber}`;
  if (p === 'walmart') {
    // Walmart URLs use the order number with no hyphen
    const walmartNum = orderNumber.replace('-', '');
    return `https://www.walmart.com/orders/${walmartNum}`;
  }
  if (p === 'costco') return `https://www.costco.com/OrderStatusCmd`;
  return null;
}

export default async function EditOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  const order = await prisma.order.findUnique({ where: { id: parseInt(id) }, include: { buyer: { select: { name: true } } } });
  if (!order) notFound();
  const isCardCenter = /cardcenter/i.test(order.buyer?.name ?? '');
  const rejectedItems = order.bfmrRejectedItems ? JSON.parse(order.bfmrRejectedItems) as { name: string; reason: string }[] : null;

  const url = merchantUrl(order.platform, order.orderNumber, order.sourceUrl);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Edit Order</h1>
          <p className="text-gray-400 text-sm mt-1">{order.itemDescription || `Order #${order.id}`}</p>
        </div>
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
      {rejectedItems && rejectedItems.length > 0 && (
        <div className="bg-red-950/40 border border-red-800 rounded-lg p-4 space-y-1">
          <p className="text-sm font-medium text-red-300">⚠ BFMR Rejected Items</p>
          {rejectedItems.map((item, i) => (
            <p key={i} className="text-xs text-red-400">{item.name}: {item.reason}</p>
          ))}
        </div>
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
      <div className="border-t border-gray-800 pt-6">
        <OrderAttachments orderId={order.id} />
      </div>
      {isCardCenter && (
        <div className="border-t border-gray-800 pt-6">
          <GiftCards orderId={order.id} />
        </div>
      )}
    </div>
  );
}
