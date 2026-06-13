import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import Link from 'next/link';
import ClearReceiptsButton from './ClearReceiptsButton';

export default async function CostcoDebugPage() {
  const userId = await getSessionUserId();

  const [orders, receipts] = await Promise.all([
    prisma.order.findMany({
      where: { platform: { in: ['Costco', 'costco'] }, ...(userId ? { userId } : { userId: null }) },
      orderBy: { orderDate: 'desc' },
      select: { id: true, orderNumber: true, orderDate: true, itemDescription: true, cost: true, sourceUrl: true },
    }),
    prisma.costcoReceipt.findMany({
      orderBy: { transactionDate: 'desc' },
      select: { id: true, transactionBarcode: true, transactionDate: true, warehouseName: true, total: true, orderId: true },
    }),
  ]);

  const unlinkedCount = receipts.filter(r => !r.orderId).length;
  const linkedCount = receipts.filter(r => r.orderId).length;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Costco Debug</h1>
          {(unlinkedCount > 0 || linkedCount > 0) && <ClearReceiptsButton count={unlinkedCount} linkedCount={linkedCount} />}
        </div>

        <div className="grid grid-cols-2 gap-6">
          <section>
            <h2 className="text-sm font-medium text-gray-400 mb-3">Orders ({orders.length})</h2>
            <div className="space-y-1">
              {orders.map(o => (
                <div key={o.id} className="bg-gray-900 border border-gray-800 rounded px-3 py-2 text-sm">
                  <div className="flex justify-between">
                    <Link href={`/orders/${o.id}`} className="text-blue-400 hover:underline font-mono text-xs">
                      #{o.orderNumber ?? '—'}
                    </Link>
                    <span className="text-gray-400">${o.cost?.toFixed(2) ?? '—'}</span>
                  </div>
                  <div className="text-gray-500 text-xs mt-0.5">{o.orderDate?.toString().split('T')[0]} · {o.itemDescription?.slice(0, 60)}</div>
                  <div className="text-gray-600 text-xs">{o.sourceUrl ? 'online' : 'in-store'}</div>
                </div>
              ))}
              {orders.length === 0 && <p className="text-gray-600 text-sm">No Costco orders found.</p>}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-medium text-gray-400 mb-3">Receipts ({receipts.length})</h2>
            <div className="space-y-1">
              {receipts.map(r => (
                <div key={r.id} className={`border rounded px-3 py-2 text-sm ${r.orderId ? 'bg-green-950/30 border-green-900' : 'bg-gray-900 border-gray-800'}`}>
                  <div className="flex justify-between">
                    <span className="font-mono text-xs text-gray-300">{r.transactionBarcode}</span>
                    <span className="text-gray-400">${r.total?.toFixed(2) ?? '—'}</span>
                  </div>
                  <div className="text-gray-500 text-xs mt-0.5">{r.transactionDate} · {r.warehouseName}</div>
                  <div className={`text-xs ${r.orderId ? 'text-green-500' : 'text-yellow-600'}`}>
                    {r.orderId ? `linked → order ${r.orderId}` : 'unlinked'}
                  </div>
                </div>
              ))}
              {receipts.length === 0 && <p className="text-gray-600 text-sm">No receipts imported yet.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
