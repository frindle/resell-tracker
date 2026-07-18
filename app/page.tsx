import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import Link from 'next/link';
import { getRange, calcStats } from '@/lib/analytics';
import { isOverdue } from '@/lib/overdue';

export const dynamic = 'force-dynamic';

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const SELECT = {
  salePrice: true, cost: true, shippingCost: true, cashbackAmount: true, portalCashback: true, orderDate: true, platform: true,
  card: { select: { milesProgram: true, basePointsPerDollar: true, merchantRates: { select: { merchant: true, pointsPerDollar: true } } } },
};

export default async function DashboardPage() {
  const userId = await getSessionUserId();
  const userFilter = userId ? { userId } : { userId: null };
  const now = new Date();

  const [allOrders, monthOrders, quarterOrders, ytdOrders] = await Promise.all([
    prisma.order.findMany({ where: { ...userFilter }, include: { buyer: true, card: { include: { merchantRates: true } } }, orderBy: { orderDate: 'desc' } }),
    prisma.order.findMany({ where: { ...userFilter, cancelled: false, orderDate: { gte: getRange('current_month', now).start } }, select: SELECT }),
    prisma.order.findMany({ where: { ...userFilter, cancelled: false, orderDate: { gte: getRange('current_quarter', now).start } }, select: SELECT }),
    prisma.order.findMany({ where: { ...userFilter, cancelled: false, orderDate: { gte: getRange('ytd', now).start } }, select: SELECT }),
  ]);

  const allStats = calcStats(allOrders);
  const monthStats = calcStats(monthOrders);
  const quarterStats = calcStats(quarterOrders);
  const ytdStats = calcStats(ytdOrders);

  const settledOrders = allOrders.filter(o => o.salePrice != null && !o.cancelled);
  const wins = settledOrders.filter(o => o.salePrice! - o.cost - o.shippingCost + o.cashbackAmount + (o.portalCashback ?? 0) > 0).length;
  const losses = settledOrders.length - wins;
  // Recent Orders hides quarantined (blockedAddressPattern set) until user
  // unblocks. They still count in all-time stats above.
  const recent = allOrders.filter(o => !o.blockedAddressPattern).slice(0, 5);

  // Outstanding money by group: unpaid (not synced) orders with a sale
  // price, less any partial payment already received. Answers "who owes
  // me what right now" without opening /orders and filtering by hand.
  const PROCESSED_STATUSES = new Set(['received', 'pkg_received', 'pkg received', 'processed', 'paid', 'payment_sent', 'complete', 'completed']);
  type Owed = { group: string; count: number; outstanding: number; overdue: number };
  const owedMap = new Map<string, Owed>();
  for (const o of allOrders) {
    if (o.lost || o.cancelled || o.salePriceSynced || !o.buyer || o.salePrice == null || o.blockedAddressPattern) continue;
    if (o.returnStatus === 'refunded' || o.returnStatus === 'written_off') continue;
    const paid = o.bgPaidAmount != null && o.bgPaidAmount > 0 ? o.bgPaidAmount : 0;
    const due = o.salePrice - paid;
    if (due <= 0.01) continue;
    const entry = owedMap.get(o.buyer.name) ?? { group: o.buyer.name, count: 0, outstanding: 0, overdue: 0 };
    entry.count++;
    entry.outstanding += due;
    if (o.overdueAt && isOverdue(o.overdueAt) && !o.bgCredited && !(o.bfmrStatus && PROCESSED_STATUSES.has(o.bfmrStatus.toLowerCase()))) entry.overdue += due;
    owedMap.set(o.buyer.name, entry);
  }
  const owedByGroup = [...owedMap.values()].sort((a, b) => b.outstanding - a.outstanding);
  const totalOwed = owedByGroup.reduce((s, g) => s + g.outstanding, 0);
  const totalOverdue = owedByGroup.reduce((s, g) => s + g.overdue, 0);

  // Needs-attention counts, mirroring the /orders status filters so each
  // chip links straight to the matching filtered view.
  const needsInfoCount = allOrders.filter(o => !o.lost && !o.cancelled && !o.blockedAddressPattern && (o.salePrice == null || !o.buyer || o.cost === 0 || !o.card)).length;
  const overdueCount = allOrders.filter(o => {
    if (o.lost || o.cancelled || o.salePriceSynced || o.blockedAddressPattern) return false;
    if (o.returnStatus === 'refunded' || o.returnStatus === 'written_off') return false;
    if (o.bgPaidAmount != null && o.bgPaidAmount > 0) {
      const expected = o.bgExpectedPayout ?? o.salePrice;
      if (expected != null && o.bgPaidAmount >= expected - 0.01) return false;
    }
    if (o.bgCredited || (o.bfmrStatus && PROCESSED_STATUSES.has(o.bfmrStatus.toLowerCase()))) return false;
    return o.overdueAt != null && isOverdue(o.overdueAt);
  }).length;
  const openReturnsCount = allOrders.filter(o => {
    if (o.returnStatus === 'refunded' || o.returnStatus === 'written_off') return false;
    if (o.returnStatus != null) return true;
    if (!o.bfmrRejectedItems) return false;
    try { const items = JSON.parse(o.bfmrRejectedItems); return Array.isArray(items) && items.length > 0; } catch { return false; }
  }).length;
  const blockedCount = allOrders.filter(o => o.blockedAddressPattern).length;

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

      {(needsInfoCount > 0 || overdueCount > 0 || openReturnsCount > 0 || blockedCount > 0) && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">Needs attention</span>
          {needsInfoCount > 0 && (
            <Link href="/orders?status=needs_info" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-yellow-950/50 border border-yellow-900 text-yellow-300 hover:bg-yellow-900/50 transition-colors">
              Needs info <span className="font-semibold">{needsInfoCount}</span>
            </Link>
          )}
          {overdueCount > 0 && (
            <Link href="/orders?status=overdue" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-red-950/50 border border-red-900 text-red-300 hover:bg-red-900/50 transition-colors">
              Overdue <span className="font-semibold">{overdueCount}</span>
            </Link>
          )}
          {openReturnsCount > 0 && (
            <Link href="/orders?status=returns" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-orange-950/50 border border-orange-900 text-orange-300 hover:bg-orange-900/50 transition-colors">
              Open returns <span className="font-semibold">{openReturnsCount}</span>
            </Link>
          )}
          {blockedCount > 0 && (
            <Link href="/orders/blocked" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-gray-900 border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors">
              Blocked imports <span className="font-semibold">{blockedCount}</span>
            </Link>
          )}
        </div>
      )}

      {owedByGroup.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Outstanding by Group</h2>
            <p className="text-sm text-gray-400">
              <span className="text-yellow-400 font-medium">{fmt(totalOwed)}</span> owed
              {totalOverdue > 0 && <> · <span className="text-red-400 font-medium">{fmt(totalOverdue)}</span> overdue</>}
            </p>
          </div>
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Group</th>
                  <th className="px-4 py-2 text-right">Orders</th>
                  <th className="px-4 py-2 text-right">Outstanding</th>
                  <th className="px-4 py-2 text-right">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {owedByGroup.map(g => (
                  <tr key={g.group} className="hover:bg-gray-900/50">
                    <td className="px-4 py-2.5 text-gray-300">{g.group}</td>
                    <td className="px-4 py-2.5 text-right text-gray-400">{g.count}</td>
                    <td className="px-4 py-2.5 text-right text-yellow-400 font-medium">{fmt(g.outstanding)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {g.overdue > 0 ? <span className="text-red-400 font-medium">{fmt(g.overdue)}</span> : <span className="text-gray-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                  const p = (o.salePrice ?? 0) - o.cost - o.shippingCost + o.cashbackAmount + (o.portalCashback ?? 0);
                  const effCost = o.cost + o.shippingCost - o.cashbackAmount - (o.portalCashback ?? 0);
                  return (
                    <tr key={o.id} className="hover:bg-gray-900/50">
                      <td className="px-4 py-3 text-gray-400">{new Date(o.orderDate).toLocaleDateString('en-CA')}</td>
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
