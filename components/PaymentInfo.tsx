import { prisma } from '@/lib/db';

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${n.toFixed(2)}`;
}

export default async function PaymentInfo({ orderId }: { orderId: number }) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      buyer: { select: { name: true } },
      bgPaidAmount: true,
      bgExpectedPayout: true,
      bgCredited: true,
      salePrice: true,
      salePriceSynced: true,
      groupReferenceId: true,
      overdueAt: true,
    },
  });
  if (!order) return null;

  const buyerName = order.buyer?.name ?? '';
  const isCardCenter = /card\s*center/i.test(buyerName);
  const isBfmr = /bfmr/i.test(buyerName);
  const isBuyingGroup = !isCardCenter && !isBfmr;

  const expected = order.bgExpectedPayout ?? order.salePrice ?? null;
  const paid = order.bgPaidAmount ?? null;
  const ref = order.groupReferenceId;

  let status: { label: string; color: string } = { label: 'Pending', color: 'text-gray-400' };
  if (order.salePriceSynced) status = { label: 'Paid', color: 'text-emerald-400' };
  else if (paid != null && expected != null && paid >= expected - 0.01) status = { label: 'Paid (unconfirmed)', color: 'text-emerald-300' };
  else if (paid != null && paid > 0) status = { label: 'Partial', color: 'text-amber-300' };
  else if (order.overdueAt && order.overdueAt < new Date()) status = { label: 'Overdue', color: 'text-red-400' };

  // Don't render anything if there's no payment context at all
  if (expected == null && paid == null && !ref && !order.overdueAt) return null;

  const heading = isCardCenter ? 'CardCenter payment' : isBfmr ? 'BFMR payment' : isBuyingGroup ? `${buyerName || 'Buying group'} payment` : 'Payment';

  return (
    <div className="border-t border-gray-800 pt-6">
      <div className="bg-gray-900/60 border border-gray-800 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-200">{heading}</h2>
          <span className={`text-xs font-medium ${status.color}`}>{status.label}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-gray-500">Expected</div>
            <div className="text-gray-200 mt-0.5">{fmt(expected)}</div>
          </div>
          <div>
            <div className="text-gray-500">Paid</div>
            <div className="text-gray-200 mt-0.5">{fmt(paid)}</div>
          </div>
          {ref && (
            <div className="col-span-2">
              <div className="text-gray-500">Reference</div>
              <div className="text-gray-200 mt-0.5 truncate" title={ref}>{ref}</div>
            </div>
          )}
          {order.bgCredited && (
            <div>
              <div className="text-gray-500">BG credited</div>
              <div className="text-emerald-300 mt-0.5">yes</div>
            </div>
          )}
          {order.overdueAt && !order.salePriceSynced && (
            <div className="col-span-2">
              <div className="text-gray-500">Overdue since</div>
              <div className={`mt-0.5 ${order.overdueAt < new Date() ? 'text-red-300' : 'text-gray-200'}`}>
                {order.overdueAt.toISOString().slice(0, 10)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
