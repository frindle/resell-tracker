import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import Link from 'next/link';
import { getRange, calcStats } from '@/lib/analytics';

export const dynamic = 'force-dynamic';

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const SELECT = {
  salePrice: true, cost: true, shippingCost: true, cashbackAmount: true, orderDate: true, platform: true,
  card: { select: { milesProgram: true, basePointsPerDollar: true, merchantRates: { select: { merchant: true, pointsPerDollar: true } } } },
};

export default async function DashboardPage() {
  const userId = await getSessionUserId();
  const userFilter = userId ? { userId } : { userId: null };
  const now = new Date();

  const [allOrders, monthOrders, quarterOrders, ytdOrders] = await Promise.all([
    prisma.order.findMany({ where: { ...userFilter }, include: { buyer: true, card: { include: { merchantRates: true } } }, orderBy: { orderDate: 'desc' } }),
    prisma.order.findMany({ where: { ...userFilter, orderDate: { gte: getRange('current_month', now).start } }, select: SELECT }),
    prisma.order.findMany({ where: { ...userFilter, orderDate: { gte: getRange('current_quarter', now).start } }, select: SELECT }),
    prisma.order.findMany({ where: { ...userFilter, orderDate: { gte: getRange('ytd', now).start } }, select: SELECT }),
  ]);

  const allStats = calcStats(allOrders);
  const monthStats = calcStats(monthOrders);
  const quarterStats = calcStats(quarterOrders);
  const ytdStats = calcStats(ytdOrders);

  const settledOrders = allOrders.filter(o => o.salePrice != null);
  const wins = settledOrders.filter(o => o.salePrice! - o.cost - o.shippingCost + o.cashbackAmount > 0).length;
  const losses = settledOrders.length - wins;
  // Recent Orders hides quarantined (blockedAddressPattern set) until user
  // unblocks. They still count in all-time stats above.
  const recent = allOrders.filter(o => !o.blockedAddressPattern).slice(0, 5);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-gray-400 mt-1 text-sm">All-time performance</p>
        </div>
        <Link href="/analytics"
          className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors">
          Full Analytics →
        </Link>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Profit</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ProfitCard label="This Month"   value={monthStats.profit} />
          <ProfitCard label="This Quarter" value={quarterStats.profit} />
          <ProfitCard label="Year to Date" value={ytdStats.profit} />
          <ProfitCard label="All Time"     value={allStats.profit} />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="All-Time Revenue"  value={fmt(allStats.revenue)} />
        <StatCard label="All-Time Cost"     value={fmt(allStats.cost)} />
        <StatCard label="All-Time Cashback" value={fmt(allStats.cashback)} colored={allStats.cashback} />
        <StatCard label="Orders" value={String(allOrders.length)} sub={`${wins}W / ${losses}L`} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Recent Orders</h2>
          <Link href="/orders" className="text-sm text-blue-400 hover:text-blue-300">View all →</Link>
        </div>
        {recent.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
            No orders yet.{' '}
            <Link href="/orders/new" className="text-blue-400 hover:text-blue-300">Add your first order.</Link>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Item</th>
                  <th className="px-4 py-2 text-left">Platform</th>
                  <th className="px-4 py-2 text-left">Buyer</th>
                  <th className="px-4 py-2 text-right">Eff. Cost</th>
                  <th className="px-4 py-2 text-right">Sale</th>
                  <th className="px-4 py-2 text-right">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {recent.map(o => {
                  const p = (o.salePrice ?? 0) - o.cost - o.shippingCost + o.cashbackAmount;
                  const effCost = o.cost + o.shippingCost - o.cashbackAmount;
                  return (
                    <tr key={o.id} className="hover:bg-gray-900/50">
                      <td className="px-4 py-3 text-gray-400">{String(o.orderDate).slice(0, 10)}</td>
                      <td className="px-4 py-3">
                        <Link href={`/orders/${o.id}`} className="hover:text-blue-400 transition-colors">
                          {o.itemDescription || '—'}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-400">{o.platform}</td>
                      <td className="px-4 py-3 text-gray-400">{o.buyer?.name || '—'}</td>
                      <td className="px-4 py-3 text-right text-gray-400">{fmt(effCost)}</td>
                      <td className="px-4 py-3 text-right">{o.salePrice != null ? fmt(o.salePrice) : <span className="text-yellow-600 text-xs">pending</span>}</td>
                      <td className={`px-4 py-3 text-right font-medium ${p >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {fmt(p)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ProfitCard({ label, value }: { label: string; value: number }) {
  const pos = value >= 0;
  return (
    <div className={`rounded-lg border p-4 ${pos ? 'border-green-900 bg-green-950/30' : 'border-red-900 bg-red-950/30'}`}>
      <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${pos ? 'text-green-400' : 'text-red-400'}`}>
        {fmt(value)}
      </p>
    </div>
  );
}

function StatCard({ label, value, colored, sub }: {
  label: string; value: string; colored?: number; sub?: string;
}) {
  const color = colored === undefined ? 'text-white' : colored >= 0 ? 'text-green-400' : 'text-red-400';
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}
