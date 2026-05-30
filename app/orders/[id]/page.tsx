import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import OrderForm from '@/components/OrderForm';

export const dynamic = 'force-dynamic';

function merchantUrl(platform: string, orderNumber: string | null, sourceUrl: string | null): string | null {
  if (sourceUrl) return sourceUrl;
  if (!orderNumber) return null;
  const p = platform.toLowerCase();
  if (p === 'amazon') return `https://www.amazon.com/gp/your-account/order-details?orderID=${orderNumber}`;
  if (p === 'walmart') return `https://www.walmart.com/orders/${orderNumber}`;
  if (p === 'costco') return `https://www.costco.com/OrderStatusCmd`;
  return null;
}

export default async function EditOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
  if (!order) notFound();

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
      <OrderForm returnTo={from} initialData={{
        ...order,
        orderDate: order.orderDate.toISOString(),
      }} />
    </div>
  );
}
