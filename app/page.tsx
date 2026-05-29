import { prisma } from '@/lib/db';
import Link from 'next/link';

function calcProfit(o: { cost: number; shippingCost: number; cashbackAmount: number; salePrice: number }) {
  return o.salePrice - (o.cost + o.shippingCost - o.cashbackAmount);
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function DashboardPage() {
  const orders = await prisma.order.findMany({
    include: { buyer: true },
    orderBy: { orderDate: 'desc' },
  });

  const totalProfit = orders.reduce((sum, o) => sum + calcProfit(o), 0);
  const totalRevenue = orders.reduce((sum, o) => sum + o.salePrice, 0);
  const wins = orders.filter(o => calcProfit(o) > 0).length;
  const losses = orders.filter(o => calcProfit(o) < 0).length;

  const now = new Date();
  const monthProfit = orders
    .filter(o => {
      const d = new Date(o.orderDate);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, o) => sum + calcProfit(o), 0);

  const recent = orders.slice(0, 5);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-gray-400 mt-1 text-sm">All-time performance</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total P&L" value={fmt(totalProfit)} colored={totalProfit} />
        <StatCard label="This Month" value={fmt(monthProfit)} colored={monthProfit} />
        <StatCard label="Total Revenue" value={fmt(totalRevenue)} />
        <StatCard label="Orders" value={String(orders.length)} sub={`${wins}W / ${losses}L`} />
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
                  const p = calcProfit(o);
                  const effCost = o.cost + o.shippingCost - o.cashbackAmount;
                  return (
                    <tr key={o.id} className="hover:bg-gray-900/50">
                      <td className="px-4 py-3 text-gray-400">{new Date(o.orderDate).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <Link href={`/orders/${o.id}`} className="hover:text-blue-400 transition-colors">
                          {o.itemDescription || '—'}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-400">{o.platform}</td>
                      <td className="px-4 py-3 text-gray-400">{o.buyer?.name || '—'}</td>
                      <td className="px-4 py-3 text-right text-gray-400">{fmt(effCost)}</td>
                      <td className="px-4 py-3 text-right">{fmt(o.salePrice)}</td>
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
