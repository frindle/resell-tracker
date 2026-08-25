'use client';

import { useEffect, useRef, useState } from 'react';
import CommitNumberInput from '@/components/CommitNumberInput';
import { linkDisplayValue, linkValueDivergence } from '@/lib/bfmrLinkValue';

type Reservation = {
  id: number;
  reserveId: string | null;
  bfmrOrderId: string | null;
  trackingNumber: string | null;
  dealTitle: string | null;
  itemName: string | null;
  status: string;
  qty: number;
  remainingQty: number;
  retailPrice: number | null;
  totalPayout: number | null;
  datePaid: string | null;
  lastSyncedAt: string | null;
  orderLinks: Array<{
    id: number;
    orderId: number;
    trackingNumber: string | null;
    quantity: number;
    value: number | null;
    order: { id: number; orderNumber: string | null; platform: string; trackingNumbers: string | null };
  }>;
};

type LinkDraft = {
  reservationId: number;
  trackingNumber: string;
  quantity: number;
  value: string;
};

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-green-900/50 text-green-300',
  processed: 'bg-blue-900/50 text-blue-300',
  shipped: 'bg-blue-900/50 text-blue-300',
  pkg_received: 'bg-blue-900/50 text-blue-300',
  purchased: 'bg-yellow-900/50 text-yellow-300',
  reserved: 'bg-yellow-900/50 text-yellow-300',
  cancelled: 'bg-gray-800 text-gray-500',
};

// Reservation statuses that assert the goods are on their way (or already
// arrived/paid). They're the only ones a per-link tracking check can
// contradict — "reserved"/"purchased"/"cancelled" describe the reservation
// as a whole and are true of every link on it.
const SHIPPED_LIKE = new Set([
  'shipped', 'pkg_received', 'processed', 'paid', 'payment_sent', 'complete', 'completed',
]);

// Per-link status label. The reservation's status is a fact about the WHOLE
// reservation, so rendering it on each link made a 1-unit link peeled off a
// qty-2 reservation show "shipped" when only the sibling link had a tracking
// number. A link counts as shipped when that link carries tracking, or when
// it covers the whole reservation and the reservation itself has tracking.
function linkStatusLabel(
  link: { trackingNumber: string | null; quantity: number },
  reservation: { status: string; qty: number; trackingNumber: string | null },
): { label: string; cls: string } {
  const cls = STATUS_STYLES[reservation.status] ?? 'bg-gray-800 text-gray-400';
  if (!SHIPPED_LIKE.has(reservation.status)) {
    return { label: reservation.status.replace(/_/g, ' '), cls };
  }
  const coversWholeReservation = link.quantity >= reservation.qty;
  const shipped = !!link.trackingNumber || (coversWholeReservation && !!reservation.trackingNumber);
  if (shipped) return { label: reservation.status.replace(/_/g, ' '), cls };
  return { label: 'awaiting tracking', cls: 'bg-yellow-900/50 text-yellow-300' };
}

export default function BfmrReservationLinker({ orderId, trackingNumbers }: { orderId: number; trackingNumbers: string | null }) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [syncMsg, setSyncMsg] = useState('');
  const [showAllUnlinked, setShowAllUnlinked] = useState(false);
  const [showGhosts, setShowGhosts] = useState(false);
  // Per-row link quantity, keyed by reservation id. Lets a qty-5 reservation be
  // linked 3-to-one-order / 2-to-another without opening the draft form.
  const [rowQty, setRowQty] = useState<Record<number, number>>({});
  const [loadingAll, setLoadingAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const didAutoSync = useRef(false);
  const [submittingLinkId, setSubmittingLinkId] = useState<number | null>(null);
  const [submitMsg, setSubmitMsg] = useState<Record<number, string>>({});
  const [clearingReservationId, setClearingReservationId] = useState<number | null>(null);

  const trackings = (trackingNumbers ?? '').split(',').map(t => t.trim()).filter(Boolean);

  // One list, one source of truth. The unscoped ("all") response is a superset
  // of the orderId-scoped one, so linksForThisOrder works off either — keeping
  // a second `allUnlinked` array around meant a successful link never cleared
  // the row from the browse-all list, which read as "the link didn't stick".
  async function load(all = showAllUnlinked) {
    setLoading(true);
    try {
      const res = await fetch(all ? '/api/bfmr/reservations' : `/api/bfmr/reservations?orderId=${orderId}`);
      const d = await res.json() as { reservations?: Reservation[]; error?: string };
      if (d.reservations) {
        setReservations(d.reservations);
        return d.reservations;
      } else {
        setError(d.error ?? 'Failed to load');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    return null;
  }

  useEffect(() => {
    load().then(async reservations => {
      if (!reservations) return;
      const hasLinks = reservations.some(r =>
        r.orderLinks.some(l => l.orderId === orderId)
      );
      if (hasLinks) return; // order is already linked — leave the picker dormant

      // Unlinked. Pull fresh from BFMR first (only once per mount), then
      // decide what to show in the picker.
      let matching = reservations;
      if (!didAutoSync.current) {
        didAutoSync.current = true;
        setAutoSyncing(true);
        try {
          await fetch('/api/bfmr/sync-reservations', { method: 'POST' });
          matching = await load() ?? matching;
        } finally {
          setAutoSyncing(false);
        }
      }
      // If nothing matched by order number or tracking, fall back to the
      // full unlinked list so the user always has something to pick from.
      const hasMatchingUnlinked = matching.some(r => r.orderLinks.length === 0);
      if (!hasMatchingUnlinked) {
        loadAllUnlinked().catch(() => {});
      }
    });
  }, []);

  async function sync() {
    setSyncing(true);
    setError('');
    try {
      const res = await fetch('/api/bfmr/sync-reservations', { method: 'POST' });
      const d = await res.json() as { synced?: number; autoLinked?: number; error?: string };
      if (d.error) setError(d.error);
      else if (d.autoLinked && d.autoLinked > 0) setSyncMsg(`Synced ${d.synced ?? 0}, auto-linked ${d.autoLinked} by order # / tracking`);
      else setSyncMsg(`Synced ${d.synced ?? 0}`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  const linksForThisOrder = reservations.flatMap(r =>
    r.orderLinks
      .filter(l => l.orderId === orderId)
      .map(l => ({ ...l, reservation: r }))
  );

  // Show only reservations with NO existing links anywhere — if a reservation
  // is already attached to a different order, surfacing it here invites
  // double-linking. Reservations linked to *this* order appear in the
  // "Linked reservations" section above.
  // Also: hide cancelled / closed reservations from the picker — they're
  // dead. And when showing "browse all unlinked" (no exact order# match),
  // narrow to reservations whose bfmrOrderId is empty — those are the
  // ones actually waiting for assignment, vs ones already tied to a
  // different order on the BFMR side.
  const isDead = (r: Reservation) => /^(cancelled|canceled|closed)$/i.test(r.status);
  // Only "reserved" reservations are actionable — everything else (paid, set
  // aside, processed, returned…) is clutter once it's past the reserve stage.
  // Exception: if BFMR shows a tracking#/order# we don't have a link for yet,
  // that's new info worth surfacing even off the "reserved" status — since
  // orderLinks.length === 0 is already the precondition for this list, an
  // unlinked reservation with tracking/order data is by definition something
  // "we don't already have recorded locally" for linking purposes.
  const isActionable = (r: Reservation) => r.status === 'reserved' || !!r.trackingNumber || !!r.bfmrOrderId;

  // GHOST RESERVATIONS: rows BFMR has stopped returning.
  //
  // sync-reservations only ever UPSERTS -- there is no prune -- so a reservation
  // BFMR drops lives here forever and clutters the link list with something that
  // cannot be acted on. `lastSyncedAt` is written on BOTH the create and update
  // branches of that upsert, so a row BFMR still knows about advances on every
  // sync while a dropped one keeps its old timestamp.
  //
  // The newest lastSyncedAt across all rows IS the last successful sync, so no
  // extra state is needed to know when that was.
  //
  // Deliberately HIDDEN, not deleted. That sync's own comment records BFMR
  // omitting live reservations twice -- a 'Purchased / Enter tracking' one was
  // invisible to every quick_filter bucket on 2026-08-23 -- so absence is not
  // proof of deletion. Hiding is reversible from the UI; deleting is not.
  // Penn accepted this trade knowingly: if a real one is ever hidden, the
  // "show N not on BFMR" toggle surfaces it and we revisit the rule.
  const lastSyncMs = reservations.reduce(
    (max, r) => Math.max(max, r.lastSyncedAt ? Date.parse(r.lastSyncedAt) : 0), 0);
  // 60s tolerance: one sync run writes its rows over a span of time, not an instant.
  const isGhost = (r: Reservation) =>
    lastSyncMs > 0 && !!r.lastSyncedAt && lastSyncMs - Date.parse(r.lastSyncedAt) > 60_000;

  const ghostCount = reservations.filter(
    r => r.orderLinks.length === 0 && !isDead(r) && isActionable(r) && isGhost(r)).length;

  const unlinkedReservations = reservations
    .filter(r => r.orderLinks.length === 0 && !isDead(r) && isActionable(r))
    .filter(r => showGhosts || !isGhost(r))
    // Browsing ALL unlinked has no order/tracking signal to justify the wider
    // net, so only genuinely open reservations belong there — paid, returned,
    // processed etc. are past the reserve stage and are pure clutter.
    .filter(r => !showAllUnlinked || (!r.bfmrOrderId && r.status === 'reserved'));

  async function loadAllUnlinked() {
    setShowAllUnlinked(true);
    setLoadingAll(true);
    try {
      await load(true);
    } finally {
      setLoadingAll(false);
    }
  }

  async function saveLink() {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const val = draft.value ? parseFloat(draft.value) : null;
      const res = await fetch('/api/bfmr/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          reservationId: draft.reservationId,
          trackingNumber: draft.trackingNumber || null,
          quantity: draft.quantity,
          value: isNaN(val as number) ? null : val,
        }),
      });
      const d = await res.json() as { id?: number; salePrice?: number; error?: string };
      if (d.error) setError(d.error);
      else {
        setDraft(null);
        if (d.salePrice != null) window.dispatchEvent(new CustomEvent('sale-price-updated', { detail: d.salePrice }));
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function splitLink(linkId: number) {
    try {
      const res = await fetch('/api/bfmr/links/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId }),
      });
      const d = await res.json() as { error?: string };
      if (d.error) setError(d.error);
      else await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeLink(linkId: number) {
    if (!confirm('Remove this BFMR link?')) return;
    try {
      const res = await fetch(`/api/bfmr/links/${linkId}`, { method: 'DELETE' });
      const d = await res.json() as { salePrice?: number };
      if (d.salePrice != null) window.dispatchEvent(new CustomEvent('sale-price-updated', { detail: d.salePrice }));
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function updateLink(
    linkId: number,
    patch: { quantity?: number; value?: number | null; trackingNumber?: string | null },
    opts: { reload?: boolean } = {},
  ) {
    // Optimistically patch the matching link in local state so the input
    // doesn't wait on a round-trip — and, critically, so we don't call
    // load() on every edit, which re-fetches and reorders the whole list
    // and makes the page jump under the cursor.
    //
    // Snapshot the pre-patch link so a failed PATCH can be rolled back.
    // Without this the optimistic edit stayed applied on any failure and
    // the edit looked saved while the server still held the old value.
    const before: { link: Reservation['orderLinks'][number] | null } = { link: null };
    setReservations(prev => prev.map(r => ({
      ...r,
      orderLinks: r.orderLinks.map(l => {
        if (l.id !== linkId) return l;
        before.link = l;
        return { ...l, ...patch };
      }),
    })));
    const rollback = () => {
      const snapshot = before.link;
      if (!snapshot) return;
      setReservations(prev => prev.map(r => ({
        ...r,
        orderLinks: r.orderLinks.map(l => (l.id === linkId ? snapshot : l)),
      })));
    };
    setError('');
    try {
      const res = await fetch(`/api/bfmr/links/${linkId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      // Check res.ok BEFORE parsing. A 4xx/5xx from this route can have an
      // empty or non-JSON body (a proxy error page, say), and res.json() on
      // that throws "Unexpected end of JSON input" — which surfaced as a
      // parse error instead of the real HTTP status, with the optimistic
      // patch left in place. Observed live on order 880.
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json() as { error?: string };
          detail = body?.error ?? '';
        } catch {
          detail = (await res.text().catch(() => '')).slice(0, 200);
        }
        rollback();
        setError(`Failed to save link (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''})${detail ? `: ${detail}` : ''}`);
        return;
      }
      const d = await res.json().catch(() => ({})) as { salePrice?: number };
      if (d.salePrice != null) window.dispatchEvent(new CustomEvent('sale-price-updated', { detail: d.salePrice }));
      // Only refetch for structural changes (add/remove/tracking) that can
      // affect matching — never for a plain value/qty edit.
      if (opts.reload) await load();
    } catch (e) {
      rollback();
      setError(String(e));
    }
  }

  // Pushes this link's own qty + tracking number to BFMR as one shipment
  // row. Each link is its own submission unit — a reservation split across
  // multiple links (e.g. via Split, or linked from two orders) submits each
  // independently rather than needing a second row-splitting UI. The
  // endpoint also auto-reconciles this link's tracking number server-side
  // (applySubmittedTrackingToLinks), so the reload after a successful
  // submit picks up any change without extra client logic.
  async function submitTracking(link: Reservation['orderLinks'][number], reservation: Reservation) {
    setSubmittingLinkId(link.id);
    setError('');
    setSubmitMsg(prev => ({ ...prev, [link.id]: '' }));
    try {
      const res = await fetch('/api/bfmr/submit-reservation-tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationId: reservation.id,
          rows: [{ qty: link.quantity, trackingNumber: link.trackingNumber }],
        }),
      });
      const d = await res.json() as { submitted?: number; totalQty?: number; error?: string };
      if (d.error) setError(d.error);
      else {
        setSubmitMsg(prev => ({ ...prev, [link.id]: `Submitted qty ${d.totalQty} to BFMR` }));
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmittingLinkId(null);
    }
  }

  // Clears locally-recorded submitted-shipment rows for a reservation whose
  // "fully submitted" state doesn't match reality on BFMR's side (e.g. the
  // my_tracker_id mismatch that let a submission land on the wrong
  // reservation's row) -- lets the submit form re-open so it can be
  // resubmitted cleanly, instead of being stuck showing "fully submitted"
  // forever.
  async function clearSubmittedShipments(reservationId: number) {
    if (!confirm('This only clears the LOCAL record — only do this if BFMR’s own portal does NOT actually show tracking for this reservation. Continue?')) return;
    setClearingReservationId(reservationId);
    setError('');
    try {
      const res = await fetch(`/api/bfmr/reservations/${reservationId}/submitted-shipments`, { method: 'DELETE' });
      const d = await res.json() as { cleared?: number; error?: string };
      if (d.error) setError(d.error);
      else await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setClearingReservationId(null);
    }
  }

  function startDraft(reservationId: number, presetQty?: number) {
    const r = reservations.find(x => x.id === reservationId);
    setDraft({
      reservationId,
      // Default to no tracking — user reserves first, then places the
      // order, then uploads tracking once shipped. Pre-selecting one
      // implies it's required. If the reservation already has tracking
      // recorded on BFMR, preserve that as a sensible default.
      trackingNumber: r?.trackingNumber ?? '',
      // Default to what is still UNLINKED, not the reservation's full qty.
      // On a qty-5 reservation already linked 3-to-Amazon, the second link
      // should offer 2 -- defaulting to 5 would silently over-link.
      quantity: presetQty ?? r?.remainingQty ?? r?.qty ?? 1,
      // PRORATE to the units being linked. Prefilling the reservation's whole
      // totalPayout put the full $485 of a qty-5 reservation onto a 3-unit link,
      // and the UI then flagged its own row: "Value $485.00 is over BFMR's
      // current share for 3 of 5 units ($291.00)". quickLink already prorated;
      // the draft path did not, so any reservation WITHOUT tracking -- which is
      // the normal case when reserving before ordering -- still over-valued.
      value: r?.totalPayout != null && r?.qty
        ? String(Math.round((r.totalPayout * (presetQty ?? r.remainingQty ?? r.qty) / r.qty) * 100) / 100)
        : (r?.totalPayout != null ? String(r.totalPayout) : ''),
    });
  }

  // Silent auto-link when the user clicks Link on a reservation that
  // already has both a tracking number AND an order_id matching one of
  // our tracking values — no need to prompt for tracking input again.
  async function quickLink(reservationId: number, quantity?: number): Promise<boolean> {
    const r = reservations.find(x => x.id === reservationId);
    if (!r || !r.trackingNumber) return false;
    // Caller-supplied quantity wins. Falls back to the unlinked remainder, and
    // only then to the full qty -- never silently links more than is left.
    const qty = Math.max(1, Math.min(quantity ?? r.remainingQty ?? r.qty, r.remainingQty ?? r.qty));
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/bfmr/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          reservationId,
          trackingNumber: r.trackingNumber,
          quantity: qty,
          // Prorate the payout to the units actually being linked, so a 3-of-5
          // link does not carry the whole reservation's value.
          value: r.totalPayout != null && (r.remainingQty ?? r.qty) > 0
            ? Math.round((r.totalPayout * qty / r.qty) * 100) / 100
            : r.totalPayout,
        }),
      });
      if (!res.ok) { setError((await res.json() as { error?: string }).error ?? 'Failed'); return false; }
      const d = await res.json() as { salePrice?: number };
      if (d.salePrice != null) window.dispatchEvent(new CustomEvent('sale-price-updated', { detail: d.salePrice }));
      // Reload reservations to refresh the linked/unlinked split
      await load();
      return true;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-gray-800 pt-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">BFMR Reservations</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={sync}
            disabled={syncing}
            className="text-xs text-gray-500 hover:text-blue-400 disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync from BFMR'}
          </button>
          <a href="/bfmr" className="text-xs text-gray-500 hover:text-blue-400">BFMR Tracker →</a>
        </div>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {syncMsg && <div className="text-xs text-emerald-400">{syncMsg}</div>}

      {loading || autoSyncing ? (
        <div className="text-xs text-gray-500">{autoSyncing ? 'Syncing reservations from BFMR…' : 'Loading…'}</div>
      ) : (
        <>
          {linksForThisOrder.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 font-medium">Linked reservations</div>
              {linksForThisOrder.map(l => {
                const r = l.reservation;
                const { label: statusLabel, cls } = linkStatusLabel(l, r);
                const share = linkDisplayValue(l, r);
                const divergence = linkValueDivergence(l, r);
                const isPartial = l.quantity < r.qty;
                return (
                  <div key={l.id} className="bg-gray-900 border border-gray-800 rounded-md p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{r.itemName || r.dealTitle || 'Reservation'}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cls} mr-1`}
                            title={statusLabel === r.status.replace(/_/g, ' ')
                              ? undefined
                              : `Reservation is "${r.status.replace(/_/g, ' ')}", but this link has no tracking number of its own`}
                          >
                            {statusLabel}
                          </span>
                          {isPartial && (
                            <span className="mr-2">
                              {l.quantity} of {r.qty} units
                              {share != null && <> · {fmtCurrency(share)}</>}
                            </span>
                          )}
                          {r.bfmrOrderId && <span className="mr-2">Order: {r.bfmrOrderId}</span>}
                          {r.reserveId && <span className="mr-2">Reserve: {r.reserveId}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {l.quantity > 1 && (
                          <button
                            onClick={() => splitLink(l.id)}
                            className="text-xs text-gray-400 hover:text-blue-400 px-2 py-1"
                            title="Peel one item off into a separate link (for split shipments)"
                          >
                            Split
                          </button>
                        )}
                        <button
                          onClick={() => removeLink(l.id)}
                          className="text-xs text-gray-500 hover:text-red-400 px-2 py-1"
                          title="Remove link"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3 items-center text-xs">
                      <label className="flex items-center gap-1 text-gray-400">
                        Tracking:
                        <select
                          value={l.trackingNumber ?? ''}
                          onChange={e => updateLink(l.id, { trackingNumber: e.target.value || null }, { reload: true })}
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none focus:border-blue-500"
                        >
                          <option value="">— no tracking yet —</option>
                          {/* keep an existing-but-unscraped value selectable so we don't silently drop it */}
                          {l.trackingNumber && !trackings.includes(l.trackingNumber) && (
                            <option value={l.trackingNumber}>{l.trackingNumber}</option>
                          )}
                          {trackings.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </label>
                      <label className="flex items-center gap-1 text-gray-400">
                        Qty:
                        <CommitNumberInput
                          min={1}
                          value={l.quantity}
                          onCommit={v => updateLink(l.id, { quantity: Math.max(1, Math.round(v ?? 1)) })}
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white w-14 focus:outline-none focus:border-blue-500"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-gray-400">
                        Value:
                        <CommitNumberInput
                          step="0.01"
                          value={l.value ?? null}
                          onCommit={v => updateLink(l.id, { value: v })}
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white w-20 focus:outline-none focus:border-blue-500"
                          placeholder="$0.00"
                        />
                      </label>
                      {r.totalPayout != null && (
                        // Explicitly labelled as the WHOLE reservation's
                        // payout. Unlabelled, this read as the link's own
                        // worth — a 1-unit link showed the full $1,460.
                        <span className="text-gray-500">
                          BFMR payout: {fmtCurrency(r.totalPayout)}
                          {isPartial && <> for all {r.qty}</>}
                        </span>
                      )}
                    </div>
                    {r.remainingQty <= 0 ? (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-emerald-400">Fully submitted to BFMR — {r.qty} of {r.qty} shipped.</span>
                        <button
                          onClick={() => clearSubmittedShipments(r.id)}
                          disabled={clearingReservationId === r.id}
                          className="text-gray-500 hover:text-red-400"
                          title="Only if BFMR’s own portal does NOT actually show tracking for this reservation"
                        >
                          {clearingReservationId === r.id ? 'clearing…' : "doesn't match BFMR? clear local record"}
                        </button>
                      </div>
                    ) : (
                      (() => {
                        const hasTracking = !!l.trackingNumber && l.trackingNumber.trim().length >= 8;
                        const overAllocated = l.quantity > r.remainingQty;
                        const canSubmit = !!r.bfmrOrderId && hasTracking && !overAllocated;
                        return (
                          <div className="flex items-center gap-2 text-xs">
                            <button
                              onClick={() => submitTracking(l, r)}
                              disabled={!canSubmit || submittingLinkId === l.id}
                              className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-2 py-1 rounded transition-colors"
                              title={!r.bfmrOrderId ? 'Reservation has no BFMR order number yet' : !hasTracking ? 'Needs a tracking number first' : overAllocated ? 'Qty exceeds what remains unsubmitted' : undefined}
                            >
                              {submittingLinkId === l.id ? 'Submitting…' : 'Submit to BFMR'}
                            </button>
                            <span className={overAllocated ? 'text-red-400' : 'text-gray-500'}>
                              {r.qty - r.remainingQty} of {r.qty} already submitted
                              {overAllocated ? ' — this link over-allocates what remains' : ''}
                            </span>
                            {submitMsg[l.id] && <span className="text-emerald-400">{submitMsg[l.id]}</span>}
                          </div>
                        );
                      })()
                    )}
                    {divergence && (
                      // value is snapshotted at link time and never re-synced,
                      // so a BFMR revision silently moves the order's payout.
                      // Surfaced, not auto-corrected: the number may have been
                      // typed by hand. Order 880: value=1460 vs a reservation
                      // worth 2190, a $730 undercount.
                      <div className="flex flex-wrap items-center gap-2 text-xs text-amber-400">
                        <span>
                          Value {fmtCurrency(divergence.actual)} is {divergence.delta < 0 ? 'under' : 'over'} BFMR&apos;s
                          current share for {l.quantity} of {r.qty} units ({fmtCurrency(divergence.expected)}) by{' '}
                          {fmtCurrency(Math.abs(divergence.delta))}.
                        </span>
                        <button
                          onClick={() => updateLink(l.id, { value: divergence.expected })}
                          className="text-blue-400 hover:underline"
                          title="Overwrite this link's value with the reservation's current payout share"
                        >
                          Use {fmtCurrency(divergence.expected)}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {linksForThisOrder.length === 0 && unlinkedReservations.length === 0 && (
            <p className="text-xs text-gray-500">
              No matching BFMR reservations found.{' '}
              <button onClick={sync} className="text-blue-400 hover:underline">Sync from BFMR</button>
              {' '}or{' '}
              <button onClick={loadAllUnlinked} disabled={loadingAll} className="text-blue-400 hover:underline disabled:opacity-50">
                {loadingAll ? 'loading…' : 'browse all unlinked reservations'}
              </button>.
            </p>
          )}

          {/* Link a new reservation */}
          {unlinkedReservations.length > 0 && !draft && (
            <div className="pt-2 border-t border-gray-800">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-gray-500 font-medium">
                  Available reservations{showAllUnlinked ? ' (all unlinked)' : ' (matching this order)'}
                </div>
                {!showAllUnlinked && (
                  <button onClick={loadAllUnlinked} disabled={loadingAll} className="text-xs text-blue-400 hover:underline disabled:opacity-50">
                    {loadingAll ? 'loading…' : 'show all unlinked'}
                  </button>
                )}
                {showAllUnlinked && (
                  <button onClick={() => { setShowAllUnlinked(false); load(false); }} className="text-xs text-gray-500 hover:text-blue-400">
                    show matching only
                  </button>
                )}
              </div>
              {(ghostCount > 0 || showGhosts) && (
                <button
                  onClick={() => setShowGhosts(g => !g)}
                  className="text-xs text-amber-500/80 hover:text-amber-400 mb-2"
                  title="These were not returned by the most recent BFMR sync. BFMR has hidden live reservations before, so they are hidden here rather than deleted."
                >
                  {showGhosts ? 'hide' : `show ${ghostCount}`} not on BFMR
                </button>
              )}
              <div className="space-y-1">
                {unlinkedReservations.map(r => {
                  const cls = STATUS_STYLES[r.status] ?? 'bg-gray-800 text-gray-400';
                  return (
                    <div key={r.id} className="flex items-center gap-2 text-xs bg-gray-900/50 border border-gray-800 rounded px-2 py-1.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded font-medium ${cls}`}>
                        {r.status.replace(/_/g, ' ')}
                      </span>
                      <span className="text-gray-300 truncate flex-1">{r.itemName || r.dealTitle || r.reserveId}</span>
                      {isGhost(r) && (
                        <span className="text-amber-500/80 whitespace-nowrap" title="Not returned by the most recent BFMR sync">not on BFMR</span>
                      )}
                      <span className="text-gray-500">qty {r.qty}</span>
                      {r.totalPayout != null && <span className="text-green-400">{fmtCurrency(r.totalPayout)}</span>}
                      {r.trackingNumber && <span className="text-gray-500 font-mono">{r.trackingNumber}</span>}
                      <label className="flex items-center gap-1 text-gray-500" title="Units of this reservation to link to THIS order">
                        qty
                        <CommitNumberInput
                          min={1}
                          integer
                          title={`1-${r.remainingQty ?? r.qty} units`}
                          value={rowQty[r.id] ?? (r.remainingQty ?? r.qty)}
                          onCommit={v => setRowQty(q => ({ ...q, [r.id]: Math.max(1, Math.min(Math.round(v ?? 1), r.remainingQty ?? r.qty)) }))}
                          className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-white w-12 focus:outline-none focus:border-blue-500"
                        />
                      </label>
                      <button
                        onClick={async () => {
                          // Silent link ONLY when there is nothing left to decide:
                          // tracking already known AND a single remaining unit, so
                          // the quantity cannot be anything but 1.
                          //
                          // A multi-unit reservation must open the draft. BFMR
                          // combines separate purchases into one reservation -- a
                          // qty-5 Apple Pencil covering 3 bought at Amazon and 2 at
                          // Walmart -- and quickLink() sends `quantity: r.qty`, so
                          // the whole 5 landed on whichever order was linked first,
                          // with no way to say otherwise. The draft has had a Qty
                          // input all along; the silent path was skipping past it.
                          // Tracking is pre-filled in the draft, so nothing is
                          // re-prompted that quickLink would have known.
                          const remaining = r.remainingQty ?? r.qty;
                          const chosen = rowQty[r.id] ?? remaining;
                          // Tracking already known -> link in ONE step at the
                          // chosen quantity. The draft is only needed when there
                          // is no tracking number to attach, which is the one
                          // thing the row cannot supply.
                          if (r.trackingNumber) {
                            const ok = await quickLink(r.id, chosen);
                            if (!ok) startDraft(r.id);
                          } else {
                            startDraft(r.id, chosen);
                          }
                        }}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-2 py-0.5 rounded transition-colors"
                      >
                        Link
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Draft form for creating a new link */}
          {draft && (
            <div className="pt-2 border-t border-gray-800 space-y-2">
              <div className="text-xs text-gray-500 font-medium">Link reservation to this order</div>
              <div className="flex flex-wrap gap-2 items-end">
                <label className="text-xs text-gray-400">
                  Tracking <span className="text-gray-500">(optional)</span>
                  <select
                    value={draft.trackingNumber}
                    onChange={e => setDraft({ ...draft, trackingNumber: e.target.value })}
                    className="block bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white mt-0.5 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— no tracking yet —</option>
                    {trackings.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="text-xs text-gray-400">
                  Qty {(() => {
                    const r = reservations.find(x => x.id === draft.reservationId);
                    return r ? <span className="text-gray-500">(of {r.qty})</span> : null;
                  })()}
                  <CommitNumberInput
                    integer
                    min={1}
                    value={draft.quantity}
                    onCommit={v => setDraft({ ...draft, quantity: v ?? 1 })}
                    className="block bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white w-16 mt-0.5 focus:outline-none focus:border-blue-500"
                  />
                </label>
                <label className="text-xs text-gray-400">
                  Value ($)
                  <input
                    type="number"
                    step="0.01"
                    value={draft.value}
                    onChange={e => setDraft({ ...draft, value: e.target.value })}
                    className="block bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white w-24 mt-0.5 focus:outline-none focus:border-blue-500"
                    placeholder="0.00"
                  />
                </label>
                <div className="flex gap-1">
                  <button
                    onClick={saveLink}
                    disabled={saving}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-1 rounded transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setDraft(null)}
                    className="text-gray-500 hover:text-white text-sm px-2 py-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Split hint */}
          {linksForThisOrder.length > 0 && trackings.length > 1 && unlinkedReservations.length > 0 && (
            <p className="text-xs text-gray-500 pt-1">
              This order has {trackings.length} tracking numbers — link the same reservation multiple times with different tracking numbers to split items across shipments.
            </p>
          )}
        </>
      )}
    </div>
  );
}
