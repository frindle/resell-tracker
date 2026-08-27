'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { type DateWindow, DATE_WINDOWS, windowStartDate } from '@/lib/dateWindow';
import { localDateStr } from '@/lib/overdue';
import { formatOrderDate, formatOrderDateIso } from '@/lib/formatOrderDate';
import { cancelWindowRemaining } from '@/lib/cancelWindow';
import { OPEN_RETURN_STATUSES, RETURN_STATUS_LABELS, hasOpenReturns, type ReturnStatus } from '@/lib/returnStatus';
import { paymentStatus, fullyReturned, PROCESSED_STATUSES } from '@/lib/paymentStatus';

type Order = {
  id: number;
  platform: string;
  orderNumber: string | null;
  orderDate: string;
  itemDescription: string | null;
  cost: number;
  shippingCost: number;
  insuranceCost: number;
  returnedCost: number;
  cashbackAmount: number;
  portalCashback: number | null;
  salePrice: number | null;
  salePriceSynced: boolean;
  buyer: { name: string } | null;
  card: { id: number; name: string; last4: string | null; milesProgram: string | null; basePointsPerDollar: number | null; merchantRates: { merchant: string; pointsPerDollar: number }[] } | null;
  trackingNumbers: string | null;
  trackingSubmittedToBg: boolean;
  bgExpectedPayout: number | null;
  bgPaidAmount: number | null;
  notes: string | null;
  sourceUrl: string | null;
  bgCredited: boolean;
  buyerMismatch: boolean;
  bfmrReceived: boolean;
  bfmrStatus: string | null;
  overdueAt: string | null;
  deliveryDeadline: string | null;
  lost: boolean;
  locked: boolean;
  cancelled: boolean;
  bfmrRejectedItems: string | null;
  returns: { status: string; quantity: number }[];
  noRushBonusPercent: number | null;
  delayedShipping: boolean;
  giftCards: { ccSubmittedAt: string | null; cardNumber: string | null }[];
  commitmentLinks: { id: number; quantity: number }[];
  bfmrLinks: { id: number; quantity: number; reservation: { status: string | null } | null }[];
  createdAt: string;
};

function estimatedMiles(o: Order): number | null {
  if (!o.card?.basePointsPerDollar && !o.card?.merchantRates.length) return null;
  // Pick the merchant rate that matches the effective % back for this
  // order. If the card has multiple rates for the same merchant
  // (e.g. Amazon Store Card at 5 / 6 / 7%), interpret them as base +
  // tier bonuses. When the order carries an Amazon No-Rush bonus we
  // captured at scrape time, pick `min(rates) + noRushBonusPercent`
  // exactly — falling back to the lowest base rate if no exact match.
  const merchantRates = o.card!.merchantRates.filter(r => r.merchant.toLowerCase() === o.platform.toLowerCase());
  let rate: number | undefined;
  if (merchantRates.length > 0) {
    const base = Math.min(...merchantRates.map(r => r.pointsPerDollar));
    const target = base + (o.noRushBonusPercent ?? 0);
    const exact = merchantRates.find(r => Math.abs(r.pointsPerDollar - target) < 0.01);
    rate = exact?.pointsPerDollar ?? base;
  } else {
    rate = o.card!.basePointsPerDollar ?? undefined;
  }
  if (!rate) return null;
  return Math.round((o.cost + o.shippingCost + o.insuranceCost) * rate);
}

function payoutMismatch(o: Order): boolean {
  if (o.salePrice == null) return false;
  // A fully-returned order resolves outside the group payout flow: salePrice
  // has been recomputed down to the remaining (zero) units while
  // bgExpectedPayout still holds the original figure, so comparing them would
  // false-flag a short-pay.
  if (fullyReturned(o)) return false;
  const isProcessed = (o.bfmrStatus && PROCESSED_STATUSES.has(o.bfmrStatus.toLowerCase())) || o.bgCredited || o.salePriceSynced;
  if (!isProcessed) return false;
  // Treat 0 as unset. CardCenter orders sometimes carry bgPaidAmount = 0
  // (not null) because the field defaults on write, which falsely tripped
  // the BG discrepancy badge with ref = $0.00.
  const paid = (o.bgPaidAmount != null && o.bgPaidAmount > 0) ? o.bgPaidAmount : null;
  const expected = (o.bgExpectedPayout != null && o.bgExpectedPayout > 0) ? o.bgExpectedPayout : null;
  // When both are set, compare expected vs actual directly (catches BFMR short-pays where
  // salePrice was updated to the actual amount but bgExpectedPayout preserves the original)
  if (expected != null && paid != null) return expected - paid >= 5;
  if (paid != null) return Math.abs(o.salePrice - paid) >= 5;
  if (expected != null) return Math.abs(o.salePrice - expected) >= 5;
  return false;
}

function needsInfo(o: Order) {
  if (o.lost || o.cancelled) return false;
  return o.salePrice == null || !o.buyer || o.cost === 0 || !o.card;
}

function hasOpenReturn(o: Order) {
  return hasOpenReturns(o.returns) || (o.bfmrRejectedItems != null && (() => {
    try { const items = JSON.parse(o.bfmrRejectedItems!); return Array.isArray(items) && items.length > 0; } catch { return false; }
  })());
}

// Row-border helper — paid orders take precedence over a stale overdueAt
// so a paid order with an old payment-due date doesn't render with a red
// "Overdue" border.
function rowBorder(o: Order): string {
  if (o.salePriceSynced) return 'border-l-2 border-green-700';
  if (paymentStatus(o) === 'overdue') return 'border-l-2 border-red-600';
  return '';
}

// returnedCost is the cost basis of units that came back (see
// lib/orderReturns.ts). salePrice already excludes those units, so the cost
// side has to drop with it or a partial return reads as pure loss.
function netCost(o: Order) {
  return o.cost + o.shippingCost + o.insuranceCost - (o.returnedCost ?? 0);
}

function profit(o: Order) {
  return (o.salePrice ?? 0) - (netCost(o) - o.cashbackAmount - (o.portalCashback ?? 0));
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

// Shows the effective cost basis. When units have been returned, the gross
// amount is struck through beside it so the original spend is still visible.
function CostCell({ o }: { o: Order }) {
  const gross = o.cost + o.shippingCost + o.insuranceCost;
  const net = netCost(o);
  if (Math.abs(gross - net) < 0.005) return <span className="text-gray-400">{fmt(gross)}</span>;
  return (
    <span className="text-gray-400" title={`Paid ${fmt(gross)}; ${fmt(o.returnedCost)} of that is on returned units`}>
      {fmt(net)} <span className="text-gray-600 line-through text-xs">{fmt(gross)}</span>
    </span>
  );
}

const PLATFORMS = ['All', 'Amazon', 'Walmart', 'Other'];
type StatusFilter = 'all' | 'needs_info' | 'complete' | 'overdue' | 'paid' | 'partial' | 'pending' | 'returns';
// Status values that have a visible filter button. Persisted/URL values
// outside this set (e.g. the removed 'complete' tab) are dropped on load so
// they can't apply an invisible filter no button can show or clear.
const BUTTON_STATUSES: StatusFilter[] = ['needs_info', 'overdue', 'paid', 'partial', 'pending', 'returns'];
type SortKey = 'date' | 'buyer' | 'profit' | 'cost' | 'sale';
type SortDir = 'asc' | 'desc';

function SortHeader({
  label, col, sortBy, sortDir, onSort, align = 'left', className = '',
}: {
  label: string; col: SortKey; sortBy: SortKey; sortDir: SortDir; onSort: (col: SortKey) => void; align?: 'left' | 'right' | 'center'; className?: string;
}) {
  const active = sortBy === col;
  const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      className={`px-4 py-2 text-${align} cursor-pointer select-none hover:text-white transition-colors ${active ? 'text-white' : 'text-gray-400'} ${className}`}
      onClick={() => onSort(col)}
    >
      {label}{arrow}
    </th>
  );
}

// Status + warning badges shared by the desktop table rows and the mobile
// cards, so the two layouts can't drift apart.
function StatusBadges({ o }: { o: Order }) {
  if (o.cancelled) return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-gray-800 text-gray-400">Cancelled</span>;
  return (
    <div className="flex flex-col gap-0.5 items-center">
      {(() => {
        const ps = paymentStatus(o);
        if (ps === 'lost') return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-gray-800 text-gray-400">Lost</span>;
        if (ps === 'paid') return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-green-900/50 text-green-300">Paid</span>;
        if (ps === 'partial') return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-blue-900/50 text-blue-300">Partial {o.bgPaidAmount != null ? fmt(o.bgPaidAmount) : ''}</span>;
        // Reservation-derived processed state: when an order's BFMR
        // items are mixed, show "Partial N/M" instead of prematurely
        // reading Processed. Only when we have linked reservations.
        const resStatuses = o.bfmrLinks.map(l => (l.reservation?.status ?? '').toLowerCase()).filter(Boolean);
        if (resStatuses.length > 0) {
          const isProc = (s: string) => s === 'processed' || s === 'paid' || s === 'payment_sent' || s === 'complete' || s === 'completed';
          const procCount = resStatuses.filter(isProc).length;
          if (procCount === resStatuses.length && !o.salePriceSynced) return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-blue-900/50 text-blue-300">Processed</span>;
          if (procCount > 0 && procCount < resStatuses.length) return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-amber-900/50 text-amber-300" title={`${procCount} of ${resStatuses.length} items processed`}>Partial {procCount}/{resStatuses.length}</span>;
        }
        if (o.bfmrStatus === 'processed' || (o.bgCredited && !o.salePriceSynced)) return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-blue-900/50 text-blue-300">Processed</span>;
        if (o.bfmrStatus === 'received' || o.bfmrStatus === 'pkg_received' || o.bfmrStatus === 'pkg received' || (o.bfmrReceived && !o.bfmrStatus)) return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-orange-900/50 text-orange-300">Received</span>;
        // overdueAt has two distinct sources: a real missed payment schedule
        // (BG receipt / CC scheduled payment — always has a salePrice by
        // then), and a 14-day-stale "no sale price ever recorded" heuristic
        // (lib/bgSync.ts) that only ever fires when salePrice is null. Label
        // the latter "Stale" — "Overdue" implies a due date was missed, and
        // there isn't one for an order that was never priced.
        if (ps === 'overdue') {
          if (o.salePrice == null) return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-amber-900/50 text-amber-300" title="No sale price recorded 14+ days after order">Stale</span>;
          return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-red-900/50 text-red-300">Overdue</span>;
        }
        if (ps === 'pending') return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-yellow-900/50 text-yellow-300">Pending</span>;
        return <span className="text-gray-600 text-xs">—</span>;
      })()}
      {o.bfmrRejectedItems && (() => {
        const items = JSON.parse(o.bfmrRejectedItems) as { name: string; reason: string }[];
        if (!items.length) return null;
        return <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-red-900/50 text-red-300" title={items.map(i => `${i.name}: ${i.reason}`).join('\n')}>⚠ {items.length} Rejected</span>;
      })()}
      {(() => {
        const remaining = cancelWindowRemaining(o.orderDate, o.platform);
        if (!remaining) return null;
        return (
          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-gray-800 text-gray-300" title="Time left within the platform's cancellation window">
            {remaining}
          </span>
        );
      })()}
      {o.deliveryDeadline && (() => {
        const dl = new Date(o.deliveryDeadline);
        const daysLeft = Math.ceil((dl.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        const overdue = daysLeft < 0;
        const near = daysLeft >= 0 && daysLeft <= 3;
        const cls = overdue
          ? 'bg-red-900/50 text-red-300'
          : near
            ? 'bg-red-900/50 text-red-300'
            : 'bg-gray-800 text-gray-300';
        const label = overdue
          ? `Ships By ${dl.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · Overdue`
          : `Ships By ${dl.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        return (
          <span
            className={`inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${cls}`}
            title={`Group delivery deadline: ${dl.toLocaleDateString()}`}
          >
            {label}
          </span>
        );
      })()}
      {(() => {
        const open = o.returns.filter(r => OPEN_RETURN_STATUSES.includes(r.status));
        const openUnits = open.reduce((s, r) => s + r.quantity, 0);
        if (openUnits > 0) return (
          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-orange-900/50 text-orange-300"
            title={open.map(r => `${r.quantity} × ${RETURN_STATUS_LABELS[r.status as ReturnStatus] ?? r.status}`).join('\n')}>
            Return: {openUnits} unit{openUnits === 1 ? '' : 's'}
          </span>
        );
        if (o.returns.some(r => r.status === 'refunded')) return (
          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap bg-green-900/40 text-green-400">
            Refunded
          </span>
        );
        return null;
      })()}
    </div>
  );
}

// The warning chips shown under the buyer name (missing tracking, unlinked
// commitments, CC pending, …) — shared by table and mobile cards.
function GroupWarningChips({ o }: { o: Order }) {
  if (!o.buyer?.name) return null;
  return (
    <>
      {!o.cancelled && !o.salePriceSynced && /buyinggroup/i.test(o.buyer.name) && o.trackingNumbers && !o.trackingSubmittedToBg && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-900/50 text-orange-300 w-fit">
          BG Missing Tracking
        </span>
      )}
      {!o.cancelled && !o.salePriceSynced && /buyinggroup|bigsky|bfmr/i.test(o.buyer.name) && !o.trackingNumbers && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-900/50 text-red-300 w-fit">
          No tracking
        </span>
      )}
      {!o.cancelled && o.commitmentLinks.length === 0 && !o.salePriceSynced && /buyinggroup/i.test(o.buyer.name) && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300 w-fit" title="Not linked to a BG commitment">
          No commitment
        </span>
      )}
      {/* Suppress when bfmrStatus is set — that means the order came from
          BFMR's sync (so a reservation obviously exists), and the only thing
          missing is the local link row, fixable on the order detail page. */}
      {o.bfmrLinks.length === 0 && !o.bfmrStatus && !o.salePriceSynced && /bfmr/i.test(o.buyer.name) && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300 w-fit" title="Not linked to a BFMR reservation">
          No reservation
        </span>
      )}
      {o.buyerMismatch && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-purple-900/50 text-purple-300 w-fit" title="Receipt found at a different buying group than assigned">
          Wrong group
        </span>
      )}
      {o.giftCards.length > 0 && o.giftCards.some(c => !c.ccSubmittedAt) && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-900/50 text-orange-300 w-fit" title="Has gift cards not yet submitted to CardCenter">
          CC pending
        </span>
      )}
    </>
  );
}

function OrdersPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  function loadPref<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(`orders_${key}`); return v != null ? JSON.parse(v) as T : fallback; } catch { return fallback; }
  }
  function savePref(key: string, value: unknown) {
    try { localStorage.setItem(`orders_${key}`, JSON.stringify(value)); } catch {}
  }

  const [orders, setOrders] = useState<Order[]>([]);
  const [platform, setPlatform] = useState(() => loadPref('platform', 'All'));
  // Multi-select status filter. Empty array == "All" (show everything).
  // The 'all' StatusFilter literal value is special — picking it clears
  // the set. Persisted as comma-joined string for URL/localStorage compat.
  const [statuses, setStatuses] = useState<StatusFilter[]>(() => {
    const raw = searchParams.get('status') ?? loadPref<string>('status', 'all');
    if (!raw || raw === 'all') return [];
    return raw.split(',').filter(s => (BUTTON_STATUSES as string[]).includes(s)) as StatusFilter[];
  });
  const toggleStatus = (s: StatusFilter) => {
    if (s === 'all') { setStatuses([]); return; }
    setStatuses(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  };
  const statusActive = (s: StatusFilter) => statuses.includes(s);
  const isAllSelected = statuses.length === 0;
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState(() => loadPref('group', 'All'));
  const [sortBy, setSortBy] = useState<SortKey>(() => loadPref<SortKey>('sortBy', 'date'));
  const [sortDir, setSortDir] = useState<SortDir>(() => loadPref<SortDir>('sortDir', 'desc'));
  const [dateWindow, setDateWindow] = useState<DateWindow>(() => loadPref<DateWindow>('dateWindow', 'all'));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [locking, setLocking] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [submittingTracking, setSubmittingTracking] = useState(false);
  const [trackingMsg, setTrackingMsg] = useState('');
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState('');
  const [syncingPlatform, setSyncingPlatform] = useState<string | null>(null);
  const [syncPlatformMsg, setSyncPlatformMsg] = useState('');
  const [changedIds, setChangedIds] = useState<Set<number>>(new Set());
  const [sidecarNeedsSetup, setSidecarNeedsSetup] = useState(false);
  const [sidecarInfo, setSidecarInfo] = useState<{ ip: string; port: number; novncPort: number } | null>(null);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => {
      setSidecarNeedsSetup(!s.vnc_password);
    }).catch(() => {});
    fetch('/api/sidecar/info').then(r => r.json()).then(setSidecarInfo).catch(() => {});
  }, []);

  useEffect(() => { savePref('platform', platform); }, [platform]);
  useEffect(() => {
    const s = statuses.length === 0 ? 'all' : statuses.join(',');
    savePref('status', s);
    // Keep the URL's ?status= param in sync with the applied filter. The param
    // is the authoritative init source (homepage deep-links rely on it), so if
    // it isn't updated when the user toggles filters it goes stale and, via the
    // `?? loadPref` precedence above, silently re-applies the old filter on the
    // next refresh even though state/localStorage say otherwise.
    const params = new URLSearchParams(searchParams.toString());
    if (s === 'all') params.delete('status'); else params.set('status', s);
    const qs = params.toString();
    router.replace(qs ? `/orders?${qs}` : '/orders', { scroll: false });
  }, [statuses]);
  useEffect(() => { savePref('group', groupFilter); }, [groupFilter]);
  useEffect(() => { savePref('sortBy', sortBy); }, [sortBy]);
  useEffect(() => { savePref('sortDir', sortDir); }, [sortDir]);
  useEffect(() => { savePref('dateWindow', dateWindow); }, [dateWindow]);

  useEffect(() => {
    // Opt in to unpaginated: /orders does client-side filtering (search,
    // status, group, badge counts) across the full set, so it needs all
    // orders. Other callers get the default 1000-row cap.
    fetch('/api/orders?all=1').then(r => r.json()).then(setOrders);
  }, []);

  useEffect(() => { setSelected(new Set()); }, [platform, statuses, search, groupFilter, sortBy]);

  function handleSort(col: SortKey) {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir(col === 'date' ? 'desc' : 'asc');
    }
  }

  const groups = ['All', ...Array.from(new Set(orders.map(o => o.buyer?.name ?? '').filter(Boolean))).sort()];

  const windowStart = windowStartDate(dateWindow);

  const filtered = orders.filter(o => {
    if (windowStart && new Date(o.orderDate) < windowStart) return false;
    if (platform === 'Other' && (o.platform === 'Amazon' || o.platform === 'Walmart')) return false;
    if (platform !== 'All' && platform !== 'Other' && o.platform !== platform) return false;
    // Multi-select: order must match ANY selected status. Empty set passes.
    if (statuses.length > 0) {
      const ps = paymentStatus(o);
      const matchAny = statuses.some(s => {
        if (s === 'needs_info') return needsInfo(o);
        if (s === 'complete')   return !needsInfo(o);
        if (s === 'overdue')    return ps === 'overdue';
        if (s === 'paid')       return ps === 'paid';
        if (s === 'partial')    return ps === 'partial';
        if (s === 'pending')    return ps === 'pending';
        if (s === 'returns')    return hasOpenReturn(o);
        return false;
      });
      if (!matchAny) return false;
    }
    if (groupFilter !== 'All' && o.buyer?.name !== groupFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      // Also match gift card last-4 so typing e.g. "1234" surfaces orders
      // with a linked card ending in 1234. Whole-code contains too, for
      // when the user types more digits.
      const cardMatch = o.giftCards.some(c => {
        if (!c.cardNumber) return false;
        const digits = c.cardNumber.replace(/\D/g, '');
        return c.cardNumber.toLowerCase().includes(q) || digits.slice(-4).includes(q);
      });
      const creditCardMatch = !!o.card && (
        o.card.name.toLowerCase().includes(q) ||
        (o.card.last4 ?? '').includes(q)
      );
      if (
        !o.itemDescription?.toLowerCase().includes(q) &&
        !o.buyer?.name.toLowerCase().includes(q) &&
        !o.orderNumber?.toLowerCase().includes(q) &&
        !o.trackingNumbers?.toLowerCase().includes(q) &&
        !cardMatch &&
        !creditCardMatch
      ) return false;
    }
    return true;
  });

  // Badge counts reflect current date/platform/group/search filters but not the status filter
  const forBadges = orders.filter(o => {
    if (windowStart && new Date(o.orderDate) < windowStart) return false;
    if (platform === 'Other' && (o.platform === 'Amazon' || o.platform === 'Walmart')) return false;
    if (platform !== 'All' && platform !== 'Other' && o.platform !== platform) return false;
    if (groupFilter !== 'All' && o.buyer?.name !== groupFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const cardMatch = o.giftCards.some(c => {
        if (!c.cardNumber) return false;
        const digits = c.cardNumber.replace(/\D/g, '');
        return c.cardNumber.toLowerCase().includes(q) || digits.slice(-4).includes(q);
      });
      const creditCardMatch = !!o.card && (
        o.card.name.toLowerCase().includes(q) ||
        (o.card.last4 ?? '').includes(q)
      );
      if (
        !o.itemDescription?.toLowerCase().includes(q) &&
        !o.buyer?.name.toLowerCase().includes(q) &&
        !o.orderNumber?.toLowerCase().includes(q) &&
        !o.trackingNumbers?.toLowerCase().includes(q) &&
        !cardMatch &&
        !creditCardMatch
      ) return false;
    }
    return true;
  });
  const needsInfoCount = forBadges.filter(needsInfo).length;
  const overdueCount = forBadges.filter(o => paymentStatus(o) === 'overdue').length;
  const paidCount = forBadges.filter(o => paymentStatus(o) === 'paid').length;
  const partialCount = forBadges.filter(o => paymentStatus(o) === 'partial').length;
  const pendingCount = forBadges.filter(o => paymentStatus(o) === 'pending').length;
  const returnsCount = forBadges.filter(hasOpenReturn).length;

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'buyer') {
      cmp = (a.buyer?.name ?? 'zzz').localeCompare(b.buyer?.name ?? 'zzz');
    } else if (sortBy === 'profit') {
      cmp = profit(a) - profit(b);
    } else if (sortBy === 'cost') {
      cmp = netCost(a) - netCost(b);
    } else if (sortBy === 'sale') {
      cmp = (a.salePrice ?? -Infinity) - (b.salePrice ?? -Infinity);
    } else {
      // Sort by the value the Date column actually displays (orderDate) —
      // sorting by createdAt made recently-imported rows with old order
      // dates float to the top. createdAt stays as the tiebreaker so
      // same-day orders keep a stable order.
      cmp = new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime();
      if (cmp === 0) cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const totalProfit = filtered
    .filter(o => o.salePrice != null)
    .reduce((s, o) => s + profit(o), 0);

  const outstandingValue = orders
    .filter(o => paymentStatus(o) === 'pending' && o.salePrice != null)
    .reduce((s, o) => s + (o.salePrice ?? 0), 0);

  const allSelected = sorted.length > 0 && sorted.every(o => selected.has(o.id));

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(sorted.map(o => o.id)));
  }

  function toggleOne(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function markSelectedPaid() {
    setMarkingPaid(true);
    await Promise.all([...selected].map(id =>
      fetch(`/api/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salePriceSynced: true, overdueAt: null }),
      })
    ));
    setOrders(prev => prev.map(o => selected.has(o.id) ? { ...o, salePriceSynced: true, overdueAt: null } : o));
    setSelected(new Set());
    setMarkingPaid(false);
  }

  // Manual "package processed" — for groups that confirm receipt/processing
  // out-of-band (CC, BigSky, or a slow BFMR sync). Sets the same
  // bfmrStatus='processed' the sync would, which drives the Processed badge.
  const [markingProcessed, setMarkingProcessed] = useState(false);
  async function markSelectedProcessed() {
    setMarkingProcessed(true);
    await Promise.all([...selected].map(id =>
      fetch(`/api/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bfmrStatus: 'processed' }),
      })
    ));
    setOrders(prev => prev.map(o => selected.has(o.id) ? { ...o, bfmrStatus: 'processed' } : o));
    setSelected(new Set());
    setMarkingProcessed(false);
  }

  async function submitTrackingForSelected() {
    setSubmittingTracking(true);
    setTrackingMsg('');
    try {
      const res = await fetch('/api/orders/submit-tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTrackingMsg(data.error ?? 'Failed');
      } else {
        const parts: string[] = [];
        if (data.results?.buyinggroup_count) parts.push(`BG: ${data.results.buyinggroup_count}`);
        if (data.results?.bigsky_count) parts.push(`BigSky: ${data.results.bigsky_count}`);
        if (data.errors?.buyinggroup) parts.push(`BG error: ${data.errors.buyinggroup}`);
        if (data.errors?.bigsky) parts.push(`BigSky error: ${data.errors.bigsky}`);
        setTrackingMsg(parts.join(' · ') || `Submitted ${data.submitted}`);
      }
    } catch (e) {
      setTrackingMsg(String(e));
    } finally {
      setSubmittingTracking(false);
    }
  }

  async function syncPlatform(type: 'SYNC_AMAZON' | 'SYNC_WALMART' | 'SYNC_COSTCO') {
    setSyncingPlatform(type);
    setSyncPlatformMsg('');
    try {
      const res = await fetch('/api/extension/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // targetBrowser: 'sidecar' — this is the headless sidecar's queue
        // now, not the browser extension's. An untargeted command is
        // claimable by ANY poller: GET /api/extension/commands matches
        // targetBrowser === null against every caller, including a real
        // installed browser extension sending X-Extension-Browser:
        // chrome/firefox on a machine that happens to be logged into the
        // tracker. That let clicking Sync here open a live Amazon tab on
        // whatever computer still has the extension installed, instead of
        // running headlessly. Targeting closes that off at the source.
        body: JSON.stringify({ type, targetBrowser: 'sidecar' }),
      });
      // Not "the extension": pressing this queues an ExtensionCommand row
      // targeted at the headless sidecar, which is what actually claims and
      // runs the Amazon/Walmart/Costco ones now. Which worker took it shows
      // up in the corner indicator as `claimedBy` rather than being
      // asserted here.
      setSyncPlatformMsg(res.ok ? 'Queued — a sync worker picks it up within ~60s' : await res.text());
    } catch (e) {
      setSyncPlatformMsg(String(e));
    } finally {
      setSyncingPlatform(null);
    }
  }

  async function resyncGroups() {
    setResyncing(true);
    setResyncMsg('Starting…');
    try {
      // BG receipt sync must run first so bgCredited is set before BFMR sync reads it.
      setResyncMsg('Syncing Groups (BG)…');
      const bgRes = await fetch('/api/buyinggroup/sync-orders', { method: 'POST' });
      // BFMR tracking submission is deliberately NOT part of resync — BFMR
      // splits multi-item orders into per-shipment rows, and matching our
      // tracking numbers to those rows by order_id alone risks assigning
      // the wrong tracking to the wrong shipment with no way to verify
      // qty/contents beforehand. Push tracking manually via the per-order
      // review UI (BfmrReservationLinker's per-link submit) instead — same reasoning as the
      // June 2026 decision to disable it from the import path
      // (see app/api/import/route.ts).
      setResyncMsg('Syncing Groups (BFMR + CC + BigSky)…');
      const [bfmrRes, ccRes, bsRes] = await Promise.all([
        fetch('/api/bfmr/full-sync', { method: 'POST' }),
        fetch('/api/cardcenter/sync-payments', { method: 'POST' }),
        fetch('/api/bigsky/sync-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fetch: true }) }),
      ]);
      const parts: string[] = [];
      if (bfmrRes.ok) {
        const d = await bfmrRes.json();
        const created = d.created ?? 0;
        const updated = d.updated ?? 0;
        parts.push(created || updated ? `BFMR: +${created} new, ${updated} updated` : 'BFMR: no changes');
      } else {
        parts.push('BFMR: failed');
      }
      if (bgRes.ok) {
        const d = await bgRes.json();
        const bgParts: string[] = [];
        if (d.updated) bgParts.push(`${d.updated} updated`);
        if (d.reset) bgParts.push(`${d.reset} reset`);
        parts.push(`BG: ${bgParts.length ? bgParts.join(', ') : 'no changes'}`);
      } else {
        parts.push('BG: failed');
      }
      if (ccRes.ok) {
        const d = await ccRes.json();
        parts.push(d.updated ? `CC: ${d.updated} updated` : `CC: ${d.message ?? 'no changes'}`);
      } else {
        parts.push('CC: failed');
      }
      if (bsRes.ok) {
        const d = await bsRes.json();
        const bsParts: string[] = [];
        if (d.updated) bsParts.push(`${d.updated} updated`);
        if (d.missing) bsParts.push(`${d.missing} missing`);
        parts.push(`BS: ${bsParts.length ? bsParts.join(', ') : 'no changes'}`);
      } else {
        parts.push('BS: failed');
      }
      setResyncMsg(parts.join(' · '));
      // Reload orders and highlight changed rows
      const prevOrders = orders;
      const res = await fetch('/api/orders');
      if (res.ok) {
        const fresh = await res.json();
        const changed = new Set<number>();
        const prevMap = new Map(prevOrders.map((o: Order) => [o.id, o]));
        for (const o of fresh) {
          const prev = prevMap.get(o.id);
          if (prev && (prev.salePriceSynced !== o.salePriceSynced || prev.bgPaidAmount !== o.bgPaidAmount || prev.bgCredited !== o.bgCredited || prev.overdueAt !== o.overdueAt)) {
            changed.add(o.id);
          }
        }
        setOrders(fresh);
        if (changed.size > 0) {
          setChangedIds(changed);
          setTimeout(() => setChangedIds(new Set()), 30000);
        }
      }
    } catch (e) {
      setResyncMsg(String(e));
    } finally {
      setResyncing(false);
    }
  }

  async function lockSelected() {
    if (!confirm(`Lock ${selected.size} order${selected.size !== 1 ? 's' : ''}?`)) return;
    setLocking(true);
    await Promise.all([...selected].map(id =>
      fetch(`/api/orders/${id}/lock`, { method: 'POST' })
    ));
    setOrders(prev => prev.map(o => selected.has(o.id) ? { ...o, locked: true } : o));
    setSelected(new Set());
    setLocking(false);
  }

  async function deleteSelected() {
    if (!confirm(`Delete ${selected.size} order${selected.size !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    setDeleting(true);
    await fetch('/api/orders/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selected] }),
    });
    setOrders(prev => prev.filter(o => !selected.has(o.id)));
    setSelected(new Set());
    setDeleting(false);
  }

  const sharedTh = 'cursor-pointer select-none hover:text-white transition-colors';
  // Return-to link preserves the active status filter(s) so backing out of
  // an order detail page restores the same view.
  const statusParam = statuses.length === 0 ? 'all' : statuses.join(',');
  const fromParam = encodeURIComponent(`/orders?status=${statusParam}`);

  // Exports the current view (filters + sort applied) so the user can
  // slice with the on-screen controls first, then take the CSV to a
  // spreadsheet for taxes/bookkeeping.
  function exportCsv() {
    const esc = (v: string | number | null | undefined) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Date', 'Platform', 'Order #', 'Item', 'Group', 'Status', 'Cost', 'Shipping', 'Insurance', 'Cashback', 'Portal Cashback', 'Sale', 'P&L', 'Tracking', 'Notes'];
    const lines = [header.join(',')];
    for (const o of sorted) {
      lines.push([
        esc(formatOrderDateIso(o.orderDate)),
        esc(o.platform),
        esc(o.orderNumber),
        esc(o.itemDescription),
        esc(o.buyer?.name),
        esc(paymentStatus(o)),
        o.cost.toFixed(2),
        o.shippingCost.toFixed(2),
        o.insuranceCost.toFixed(2),
        o.cashbackAmount.toFixed(2),
        (o.portalCashback ?? 0).toFixed(2),
        o.salePrice != null ? o.salePrice.toFixed(2) : '',
        o.salePrice != null ? profit(o).toFixed(2) : '',
        esc(o.trackingNumbers),
        esc(o.notes),
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders-${localDateStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {sidecarNeedsSetup && (
        <div className="text-amber-400 text-sm bg-amber-950/30 border border-amber-900/50 rounded px-4 py-2 flex items-center justify-between gap-3">
          <span>Sidecar isn&apos;t set up for your account yet — you won&apos;t be able to connect for interactive logins.</span>
          <a href="/settings" className="whitespace-nowrap underline hover:text-amber-300">Set it up in Settings →</a>
        </div>
      )}
      {!sidecarNeedsSetup && sidecarInfo && (
        <a
          href={`http://${sidecarInfo.ip}:${sidecarInfo.novncPort}/vnc.html?autoconnect=true&resize=scale`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-xs text-gray-500 hover:text-blue-400 underline"
        >
          Connect to sidecar (opens in browser) →
        </a>
      )}
      {/* flex-wrap: the button group drops to its own row when it doesn't
          fit next to the title (mobile, or wide P&L numbers) instead of
          painting over the text. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="space-y-2 min-w-0 flex-1 basis-72">
          <div className="flex items-baseline gap-3 whitespace-nowrap">
            <h1 className="text-2xl font-bold">Orders</h1>
            <a href="/orders/blocked" className="text-xs text-gray-500 hover:text-yellow-300" title="Address-blocked orders awaiting review">
              Blocked imports →
            </a>
          </div>
          {selected.size > 0 && (
            // Single row always; overflow-x-auto lets it scroll on
            // narrow/mobile screens instead of wrapping or overflowing
            // into the sync buttons. Submit Tracking button removed —
            // auto-submit on import covers BG + BigSky; BFMR will get
            // its own review UI separately.
            <div className="flex flex-nowrap gap-2 items-center overflow-x-auto">
              <span className="text-xs text-gray-500 whitespace-nowrap">{selected.size} selected</span>
              <button onClick={markSelectedPaid} disabled={markingPaid}
                className="bg-green-800 hover:bg-green-700 disabled:opacity-50 text-green-200 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
                {markingPaid ? 'Marking…' : `Mark ${selected.size} Paid`}
              </button>
              <button onClick={markSelectedProcessed} disabled={markingProcessed}
                title="Mark package(s) as processed by the group — same state the BFMR/BG sync sets"
                className="bg-blue-900/60 hover:bg-blue-800/60 disabled:opacity-50 text-blue-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
                {markingProcessed ? 'Marking…' : `Mark ${selected.size} Processed`}
              </button>
              <button onClick={lockSelected} disabled={locking}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
                {locking ? 'Locking…' : `Lock ${selected.size}`}
              </button>
              <button onClick={deleteSelected} disabled={deleting}
                className="bg-red-900/60 hover:bg-red-900 disabled:opacity-50 text-red-400 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
                {deleting ? 'Deleting…' : `Delete ${selected.size}`}
              </button>
            </div>
          )}
        </div>
        {/* flex-nowrap + shrink-0: every action button (sync + the rest)
            stays on ONE line. On a narrow viewport it scrolls horizontally
            (same pattern as the bulk-select row above) instead of wrapping
            into a ragged block or a second row. */}
        <div className="flex flex-nowrap gap-2 items-center justify-end shrink-0 overflow-x-auto max-w-full">
          {(['SYNC_AMAZON', 'SYNC_WALMART', 'SYNC_COSTCO'] as const).map(type => {
            const label = type === 'SYNC_AMAZON' ? 'Amazon' : type === 'SYNC_WALMART' ? 'Walmart' : 'Costco';
            return (
              // Labels stay constant while syncing (feedback goes to the
              // status line below) so button widths — and the whole header
              // layout — never shift mid-sync.
              <button key={type} onClick={() => syncPlatform(type)} disabled={syncingPlatform !== null}
                className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
                Sync {label}
              </button>
            );
          })}
          <button onClick={resyncGroups} disabled={resyncing}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
            Resync Groups
          </button>
          <button onClick={exportCsv} disabled={sorted.length === 0}
            title="Download the current view (filters + sort applied) as CSV"
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
            Export CSV
          </button>
          <Link href="/import" className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
            Import
          </Link>
          <Link href="/orders/bulk-upload" className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
            Bulk Upload
          </Link>
          <Link href="/orders/sort-assign" className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
            Sort &amp; Assign
          </Link>
          <Link href="/orders/new" className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
            + New Order
          </Link>
        </div>
      </div>
      {/* Stats on their own full-width row below the header/buttons so the
          amounts never scroll or get squeezed by the sync buttons; wraps
          naturally if it ever outgrows the row. */}
      <p className="text-gray-400 text-sm -mt-4">
        {filtered.length} orders
        {filtered.some(o => o.salePrice != null) && (
          <> · P&L: <span className={totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}>{fmt(totalProfit)}</span></>
        )}
        {outstandingValue > 0 && (
          <> · Outstanding: <span className="text-yellow-400">{fmt(outstandingValue)}</span></>
        )}
      </p>
      <div className="text-right -mt-4 min-h-[1rem]">
        {(syncPlatformMsg || resyncMsg) && (
          <span className="text-xs text-gray-500">{syncPlatformMsg || resyncMsg}</span>
        )}
        {/* Mount point for the browser extension's live sync-status banner.
            Kept, but it is no longer where the status comes from: the
            extension is not what runs these syncs any more, so this element
            stays empty in practice. components/SyncStatusIndicator.tsx reads
            the ExtensionCommand queue directly and draws the corner banner
            for whichever worker actually claims the command. Removing this
            would silently break the banner for anyone still running the
            extension for the commands the sidecar does not cover. */}
        <div data-rt-sync-target className="mt-1"></div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <div className="relative w-64">
          <input
            type="text"
            placeholder="Search item, buyer, order #, tracking, card…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-md pl-3 pr-8 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-full"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-base leading-none"
              title="Clear search"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        {/* Status filter — multi-select. "All" clears the set. */}
        <div className="flex flex-wrap gap-1">
          <button onClick={() => toggleStatus('all')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${isAllSelected ? 'bg-blue-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            All
          </button>
          <button onClick={() => toggleStatus('needs_info')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${statusActive('needs_info') ? 'bg-yellow-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Needs Info
            {needsInfoCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${statusActive('needs_info') ? 'bg-yellow-500 text-white' : 'bg-yellow-900/60 text-yellow-400'}`}>
                {needsInfoCount}
              </span>
            )}
          </button>
          <button onClick={() => toggleStatus('overdue')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${statusActive('overdue') ? 'bg-red-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Overdue
            {overdueCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${statusActive('overdue') ? 'bg-red-500 text-white' : 'bg-red-900/60 text-red-400'}`}>
                {overdueCount}
              </span>
            )}
          </button>
          <button onClick={() => toggleStatus('paid')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${statusActive('paid') ? 'bg-green-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Paid
            {paidCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${statusActive('paid') ? 'bg-green-500 text-white' : 'bg-green-900/60 text-green-400'}`}>
                {paidCount}
              </span>
            )}
          </button>
          <button onClick={() => toggleStatus('partial')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${statusActive('partial') ? 'bg-blue-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Partial
            {partialCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${statusActive('partial') ? 'bg-blue-500 text-white' : 'bg-blue-900/60 text-blue-400'}`}>
                {partialCount}
              </span>
            )}
          </button>
          <button onClick={() => toggleStatus('pending')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${statusActive('pending') ? 'bg-yellow-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Pending
            {pendingCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${statusActive('pending') ? 'bg-yellow-500 text-white' : 'bg-yellow-900/60 text-yellow-400'}`}>
                {pendingCount}
              </span>
            )}
          </button>
          <button onClick={() => toggleStatus('returns')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${statusActive('returns') ? 'bg-orange-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Returns
            {returnsCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${statusActive('returns') ? 'bg-orange-500 text-white' : 'bg-orange-900/60 text-orange-400'}`}>
                {returnsCount}
              </span>
            )}
          </button>
        </div>

        {/* Platform filter */}
        <div className="flex flex-wrap gap-1">
          {PLATFORMS.map(p => (
            <button key={p} onClick={() => setPlatform(p)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${platform === p ? 'bg-gray-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
              {p}
            </button>
          ))}
        </div>

        {/* Group filter */}
        {groups.length > 1 && (
          <select
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
          >
            {groups.map(g => (
              <option key={g} value={g}>{g === 'All' ? 'All Groups' : g}</option>
            ))}
          </select>
        )}

        {/* Date window */}
        <select
          value={dateWindow}
          onChange={e => setDateWindow(e.target.value as DateWindow)}
          className="ml-auto bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          {DATE_WINDOWS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
          {statuses.includes('needs_info') ? 'All orders are complete.' : 'No orders found.'}
        </div>
      ) : (
        <>
        {/* Mobile: card list (< md). Same data, same badges, tap to open. */}
        <div className="md:hidden space-y-3">
          {sorted.map(o => {
            const incomplete = needsInfo(o);
            const p = profit(o);
            const isSelected = selected.has(o.id);
            return (
              <div
                key={o.id}
                onClick={e => {
                  const el = e.target as HTMLElement;
                  if (el.closest('a,button,input,label')) return;
                  router.push(`/orders/${o.id}?from=${fromParam}`);
                }}
                className={`rounded-lg border border-gray-800 p-3 space-y-2 cursor-pointer ${incomplete ? 'opacity-75' : ''} ${changedIds.has(o.id) ? 'bg-yellow-950/40' : isSelected ? 'bg-blue-950/30' : 'bg-gray-950'} ${rowBorder(o)}`}
              >
                <div className="flex items-start gap-2">
                  <input type="checkbox" checked={isSelected} onChange={() => toggleOne(o.id)} className="accent-blue-500 mt-1 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/orders/${o.id}?from=${fromParam}`} className="hover:text-blue-400 transition-colors block truncate font-medium">
                      {o.itemDescription || '—'}
                    </Link>
                    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 mt-0.5">
                      <span className="text-xs text-gray-500">
                        {formatOrderDate(o.orderDate, { dateOnly: true })} · {o.platform}
                        {o.buyer?.name ? <> · {o.buyer.name}</> : <span className="text-yellow-600"> · no buyer</span>}
                        {o.orderNumber && <span className="font-mono"> · #{o.orderNumber}</span>}
                      </span>
                      <div className="ml-auto flex flex-wrap gap-1 justify-end">
                        <StatusBadges o={o} />
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {o.salePrice != null
                      ? <span className={`font-medium ${p >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(p)}</span>
                      : <span className="text-gray-600">—</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 items-start">
                  <GroupWarningChips o={o} />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500 text-xs">
                    Cost: {o.cost === 0 ? <span className="text-yellow-600">needed</span> : <CostCell o={o} />}
                    {' · '}Sale: {o.salePrice != null
                      ? <span className="text-gray-300">{fmt(o.salePrice)}{payoutMismatch(o) ? ' ⚠' : ''}</span>
                      : <span className="text-yellow-600">needed</span>}
                  </span>
                  <Link href={`/orders/${o.id}?from=${fromParam}`}
                    className={`text-xs transition-colors ${incomplete ? 'text-yellow-600 hover:text-yellow-400' : 'text-gray-500 hover:text-white'}`}>
                    {incomplete ? 'Fill in →' : 'Edit'}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop: full table (md+) */}
        <div className="hidden md:block rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-blue-500" />
                </th>
                {/* Every column in this table is deliberately text-center, including Item (both
                    its title and order-number line) and the money columns -- settled 2026-08-23
                    after repeated confusion from a mixed left/center/right scheme. Keep new
                    columns consistent with this. */}
                {/* w-20 (80px) was narrower than the date it holds: MM/DD/YYYY at
                    text-sm is ~76px, and with px-4 the cell only had 48px of content
                    box, so a whitespace-nowrap centred date spilled out both sides and
                    ended up touching the order number in the Item cell. Sized to fit
                    the text, with the padding trimmed on the data cells so the width
                    Item gives up stays small. */}
                <SortHeader label="Date" col="date" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-[104px]" />
                <th className="px-4 py-2 text-center text-gray-400">Item</th>
                <th className="hidden sm:table-cell px-4 py-2 text-center text-gray-400 w-20">Platform</th>
                <SortHeader label="Group" col="buyer" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-32" />
                <th className="px-4 py-2 text-center text-gray-400 w-[110px]">Status</th>
                <SortHeader label="Cost" col="cost" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-20" />
                <th className="hidden lg:table-cell px-4 py-2 text-center text-gray-400 w-20">Cashback</th>
                <th className="hidden lg:table-cell px-4 py-2 text-center text-gray-400 w-20 whitespace-nowrap">Portal CB</th>
                <th className="hidden lg:table-cell px-4 py-2 text-center text-gray-400 w-24">Miles</th>
                <SortHeader label="Sale" col="sale" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-20" />
                <SortHeader label="P&L" col="profit" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-24" />
                <th className="px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {sorted.map(o => {
                const incomplete = needsInfo(o);
                const p = profit(o);
                const isSelected = selected.has(o.id);
                return (
                  <tr
                    key={o.id}
                    onClick={e => {
                      const el = e.target as HTMLElement;
                      if (el.closest('a,button,input,label')) return;
                      router.push(`/orders/${o.id}?from=${fromParam}`);
                    }}
                    className={`hover:bg-gray-900/50 cursor-pointer ${incomplete ? 'opacity-75' : ''} ${changedIds.has(o.id) ? 'bg-yellow-950/40' : isSelected ? 'bg-blue-950/30' : ''} ${rowBorder(o)}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleOne(o.id)} className="accent-blue-500" />
                    </td>
                    <td className="px-2 py-2 text-gray-400 whitespace-nowrap text-center">{formatOrderDate(o.orderDate, { dateOnly: true })}</td>
                    <td className="px-4 py-2 overflow-hidden text-center">
                      {/* Two lines of the item name instead of one. min-h holds the
                          block at its full two-line height whether the name needs one
                          line or two, so rows keep a single, uniform height and the
                          other columns don't shuffle up and down the list. */}
                      <Link href={`/orders/${o.id}?from=${fromParam}`} className="hover:text-blue-400 transition-colors line-clamp-2 min-h-10">
                        {o.itemDescription || '—'}
                      </Link>
                      {o.orderNumber && (() => {
                        const href = o.platform.toLowerCase() === 'costco'
                          ? (o.sourceUrl ? `https://www.costco.com/myaccount/#/app/4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf/orderdetails/${o.orderNumber}` : null)
                          : o.sourceUrl;
                        // Hyphenated order numbers (Amazon 123-4567890-1234567) get a
                        // <wbr/> after each hyphen so the wrap lands on the hyphen rather
                        // than mid-digit. Walmart's are NOT hyphenated in practice --
                        // they arrive as one unbroken 16-digit run (2000148663318260),
                        // which has no wrap opportunity at all, so this cell used to clip
                        // them instead of wrapping. break-words lets a run with no break
                        // opportunity of its own split rather than overflow; the <wbr/>
                        // points are still preferred, so hyphenated numbers keep breaking
                        // where they read best. min-h reserves the full three lines an
                        // Amazon 3-7-7 number needs at this column width -- reserving
                        // only two left every Amazon row 12px taller than every Walmart
                        // row, which is the ragged spacing this was meant to avoid.
                        // Uniform at the height the tallest row already needed.
                        const segments = o.orderNumber.split('-');
                        const label = segments.length > 1
                          ? segments.map((seg, i) => (
                              <span key={i}>{i > 0 && <>-<wbr /></>}{seg}</span>
                            ))
                          : o.orderNumber;
                        const className = 'text-xs font-mono block text-center mt-1 break-words min-h-12' + (href ? ' text-blue-400 hover:underline' : ' text-gray-500');
                        return href
                          ? <a href={href} target="_blank" rel="noreferrer" className={className}>#{label}</a>
                          : <span className={className}>#{label}</span>;
                      })()}
                      {/* Same reserved height for the handful of orders that have no
                          order number, so those rows are not shorter than the rest. */}
                      {!o.orderNumber && <span className="block mt-1 min-h-12" aria-hidden="true" />}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-2 text-gray-400 text-center">{o.platform}</td>
                    <td className="px-4 py-2 overflow-hidden text-center">
                      {o.buyer?.name
                        ? <div className="flex flex-col gap-0.5 items-center">
                            <span className="text-gray-400 truncate block">{o.buyer.name}</span>
                            <GroupWarningChips o={o} />
                          </div>
                        : <span className="text-yellow-600 text-xs">no buyer</span>}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <StatusBadges o={o} />
                    </td>
                    <td className="px-4 py-2 text-center">
                      {o.cancelled
                        ? <span className="text-gray-600 text-xs">Cancelled</span>
                        : o.cost === 0
                          ? <span className="text-yellow-600 text-xs">needed</span>
                          : <CostCell o={o} />}
                    </td>
                    <td className="hidden lg:table-cell px-4 py-2 text-center text-green-400/70">{o.cancelled ? <span className="text-gray-600">—</span> : o.cashbackAmount > 0 ? fmt(o.cashbackAmount) : '—'}</td>
                    <td className="hidden lg:table-cell px-4 py-2 text-center text-green-400/70">{o.cancelled ? <span className="text-gray-600">—</span> : (o.portalCashback ?? 0) > 0 ? fmt(o.portalCashback!) : '—'}</td>
                    <td className="hidden lg:table-cell px-4 py-2 text-center text-blue-400/70">{(() => { const m = estimatedMiles(o); if (!m) return '—'; const prog = o.card?.milesProgram; return prog ? `${m.toLocaleString()} ${prog}` : m.toLocaleString(); })()}</td>
                    <td className="px-4 py-2 text-center whitespace-nowrap">
                      {o.cancelled
                        ? <span className="text-gray-600 text-xs">Cancelled</span>
                        : o.salePrice != null
                          ? <div className="flex flex-col items-center gap-0.5">
                              <span>{fmt(o.salePrice)}</span>
                              {payoutMismatch(o) && (() => {
                                const ref = (o.bgExpectedPayout != null && o.bgPaidAmount != null) ? o.bgExpectedPayout : (o.bgPaidAmount ?? o.bgExpectedPayout!);
                                return (
                                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-900/50 text-orange-300" title={`Paid/expected ${fmt(ref)}`}>
                                    ≠ {fmt(ref)}
                                  </span>
                                );
                              })()}
                            </div>
                          : <span className="text-yellow-600 text-xs">needed</span>}
                    </td>
                    <td className="px-4 py-2 text-center font-medium whitespace-nowrap">
                      {o.cancelled
                        ? <span className="text-gray-600 text-xs">Cancelled</span>
                        : o.salePrice != null
                          ? <span className={p >= 0 ? 'text-green-400' : 'text-red-400'}>{fmt(p)}</span>
                          : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Link href={`/orders/${o.id}?from=${fromParam}`}
                        className={`text-xs transition-colors ${incomplete ? 'text-yellow-600 hover:text-yellow-400' : 'text-gray-500 hover:text-white'}`}>
                        {incomplete ? 'Fill in →' : 'Edit'}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}

export default function OrdersPage() {
  return <Suspense><OrdersPageInner /></Suspense>;
}
