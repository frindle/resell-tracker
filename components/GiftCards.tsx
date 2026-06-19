'use client';

import { useEffect, useState } from 'react';

type GiftCard = {
  id: number;
  merchant: string;
  value: number;
  cardNumber: string;
  pin: string | null;
  ccSubmittedAt: string | null;
  ccGiftCardId: string | null;
  ccReservationId: number | null;
  ccSubmissionId: string | null;
};

type CcRate = {
  id: number;
  brandName: string;
  value: number;
  rate: number;
  paymentTerms: number;
  maximumPaymentTerms: number;
  flexType: string;
  availableCap: number;
};

type CcOpenReservation = {
  id: number;
  brandName: string;
  value: number;
  quantity: number;
  submissionDeadline: string;
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(s: string) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function groupKey(c: GiftCard) {
  return `${c.merchant.toLowerCase()}::${c.value}`;
}

function ReservationPanel({ cards, orderId, onReserved }: {
  cards: GiftCard[];
  orderId: number;
  onReserved: (updatedCards: GiftCard[]) => void;
}) {
  const merchant = cards[0].merchant;
  const value = cards[0].value;
  const [rates, setRates] = useState<CcRate[] | null>(null);
  const [openReservations, setOpenReservations] = useState<CcOpenReservation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [ratesError, setRatesError] = useState('');
  const [selectedRateId, setSelectedRateId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(cards.length);
  const [reserving, setReserving] = useState(false);
  const [reserveError, setReserveError] = useState('');
  const [fulfilling, setFulfilling] = useState<number | null>(null);
  const [fulfillError, setFulfillError] = useState('');
  const [cancelling, setCancelling] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/cardcenter/rates?brand=${encodeURIComponent(merchant)}&value=${value}`).then(r => r.json()),
      fetch(`/api/cardcenter/reservations?brand=${encodeURIComponent(merchant)}&value=${value}`).then(r => r.json()),
    ])
      .then(([ratesData, resData]: [{ rates?: CcRate[]; error?: string }, { reservations?: CcOpenReservation[]; error?: string }]) => {
        if (ratesData.error) setRatesError(ratesData.error);
        else {
          setRates(ratesData.rates ?? []);
          if (ratesData.rates?.length === 1) setSelectedRateId(ratesData.rates[0].id);
        }
        setOpenReservations(resData.reservations ?? []);
      })
      .catch(() => setRatesError('Failed to load rates'))
      .finally(() => setLoading(false));
  }, [merchant, value]);

  async function cancelReservation(reservationId: number) {
    if (!confirm(`Cancel reservation #${reservationId}? This cannot be undone.`)) return;
    setCancelling(reservationId);
    try {
      await fetch(`/api/cardcenter/reservations/${reservationId}`, { method: 'DELETE' });
      setOpenReservations(prev => prev?.filter(r => r.id !== reservationId) ?? null);
    } catch { /* non-fatal */ } finally {
      setCancelling(null);
    }
  }

  async function fulfillReservation(reservationId: number) {
    setFulfilling(reservationId);
    setFulfillError('');
    try {
      const res = await fetch('/api/cardcenter/fulfill-reservation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId, cardIds: cards.map(c => c.id) }),
      });
      const d = await res.json() as { submitted?: number; error?: string };
      if (!res.ok || d.error) { setFulfillError(d.error ?? 'Failed'); return; }
      const updated = await fetch(`/api/orders/${orderId}/gift-cards`).then(r => r.json()) as GiftCard[];
      onReserved(updated);
    } catch (e) {
      setFulfillError(String(e));
    } finally {
      setFulfilling(null);
    }
  }

  async function createReservation() {
    if (!selectedRateId) return;
    setReserving(true);
    setReserveError('');
    try {
      const res = await fetch('/api/cardcenter/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyOrderId: selectedRateId, quantity, cardIds: cards.map(c => c.id) }),
      });
      const d = await res.json() as { reservationId?: number; submissionDeadline?: string; submitted?: number; submitError?: string; error?: string };
      if (!res.ok || d.error) { setReserveError(d.error ?? 'Reservation failed'); return; }
      if (d.submitError) setReserveError(`Reserved but submit failed: ${d.submitError}`);
      const updated = await fetch(`/api/orders/${orderId}/gift-cards`).then(r => r.json()) as GiftCard[];
      onReserved(updated);
    } catch (e) {
      setReserveError(String(e));
    } finally {
      setReserving(false);
    }
  }

  const selectedRate = rates?.find(r => r.id === selectedRateId);

  return (
    <div className="mt-2 bg-gray-900 border border-gray-700 rounded p-3 space-y-3">
      <p className="text-xs font-medium text-gray-300">
        Submit {cards.length} × {merchant} {fmt(value)}
      </p>

      {loading && <p className="text-xs text-gray-500">Loading…</p>}
      {ratesError && <p className="text-xs text-red-400">{ratesError}</p>}

      {/* Open reservations — fulfill an existing one */}
      {openReservations && openReservations.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Open reservations</p>
          {openReservations.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-2 bg-green-950/30 border border-green-900/50 rounded px-2 py-1.5">
              <span className="text-xs text-green-400">
                #{r.id} · {r.quantity} cards · Due {fmtDate(r.submissionDeadline)}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => fulfillReservation(r.id)}
                  disabled={fulfilling === r.id || cancelling === r.id}
                  className="text-xs bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white px-2 py-1 rounded transition-colors"
                >
                  {fulfilling === r.id ? 'Submitting…' : 'Submit to this'}
                </button>
                <button
                  onClick={() => cancelReservation(r.id)}
                  disabled={cancelling === r.id || fulfilling === r.id}
                  className="text-xs text-red-500 hover:text-red-400 disabled:opacity-50 transition-colors"
                >
                  {cancelling === r.id ? '…' : 'Cancel'}
                </button>
              </div>
            </div>
          ))}
          {fulfillError && <p className="text-xs text-red-400">{fulfillError}</p>}
          {rates && rates.length > 0 && (
            <p className="text-xs text-gray-600 pt-1">— or reserve &amp; submit in one step —</p>
          )}
        </div>
      )}

      {/* Reserve + submit flow */}
      {rates && rates.length === 0 && !openReservations?.length && (
        <p className="text-xs text-yellow-500">No open buy orders or reservations found for {merchant} {fmt(value)}</p>
      )}

      {rates && rates.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {rates.map(r => (
              <button
                key={r.id}
                onClick={() => setSelectedRateId(r.id)}
                className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                  selectedRateId === r.id
                    ? 'bg-blue-700 border-blue-600 text-white'
                    : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                }`}
              >
                {(r.rate * 100).toFixed(1)}% · {r.paymentTerms}d
                {r.flexType !== 'None' && <span className="text-gray-400"> (flex to {r.maximumPaymentTerms}d)</span>}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-400">Quantity</label>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            />
            {selectedRate && (
              <span className="text-xs text-gray-500">Cap: {fmt(selectedRate.availableCap)}</span>
            )}
          </div>

          {reserveError && <p className="text-xs text-red-400">{reserveError}</p>}

          <button
            onClick={createReservation}
            disabled={!selectedRateId || reserving}
            className="text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white px-4 py-1.5 rounded transition-colors"
          >
            {reserving ? 'Reserving & submitting…' : 'Reserve & Submit'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function GiftCards({ orderId }: { orderId: number }) {
  const [cards, setCards] = useState<GiftCard[]>([]);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ merchant: '', value: '', cardNumber: '', pin: '' });
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState('');
  const [ccBrands, setCcBrands] = useState<string[]>([]);
  const [editingCcId, setEditingCcId] = useState<number | null>(null);
  const [ccIdDraft, setCcIdDraft] = useState('');

  useEffect(() => {
    fetch(`/api/orders/${orderId}/gift-cards`).then(r => r.json()).then(setCards);
  }, [orderId]);

  useEffect(() => {
    if (!adding || ccBrands.length > 0) return;
    fetch('/api/cardcenter/brands')
      .then(r => r.json())
      .then((d: { brands: string[] }) => setCcBrands(d.brands))
      .catch(() => {});
  }, [adding]);

  async function addCard() {
    if (!form.merchant || !form.value || !form.cardNumber) return;
    const res = await fetch(`/api/orders/${orderId}/gift-cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant: form.merchant, value: parseFloat(form.value), cardNumber: form.cardNumber, pin: form.pin || null }),
    });
    if (res.ok) {
      const card = await res.json();
      setCards(prev => [...prev, card]);
      setForm({ merchant: '', value: '', cardNumber: '', pin: '' });
      setAdding(false);
    }
  }

  async function remove(cardId: number) {
    const res = await fetch(`/api/orders/${orderId}/gift-cards`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId }),
    });
    if (res.ok) setCards(prev => prev.filter(c => c.id !== cardId));
  }

  function toggleReveal(id: number) {
    setRevealed(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function toggleCcSubmitted(cardId: number, currentValue: string | null) {
    const ccSubmittedAt = currentValue ? null : new Date().toISOString();
    const res = await fetch(`/api/orders/${orderId}/gift-cards`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId, ccSubmittedAt }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, ccSubmittedAt: updated.ccSubmittedAt } : c));
    }
  }

  async function saveCcGiftCardId(cardId: number) {
    const res = await fetch(`/api/orders/${orderId}/gift-cards`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId, ccGiftCardId: ccIdDraft.trim() || null }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, ccGiftCardId: updated.ccGiftCardId } : c));
    }
    setEditingCcId(null);
  }

  async function clearReservation(groupCards: GiftCard[]) {
    if (!confirm('Clear the stale reservation link? You can create a new reservation after.')) return;
    await Promise.all(groupCards.map(c =>
      fetch(`/api/orders/${orderId}/gift-cards`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: c.id, ccReservationId: null, ccSubmissionId: null }),
      })
    ));
    setCards(prev => prev.map(c =>
      groupCards.some(g => g.id === c.id) ? { ...c, ccReservationId: null, ccSubmissionId: null } : c
    ));
  }

  async function submitToCardCenter() {
    setSubmitting(true);
    setSubmitMsg('');
    try {
      const res = await fetch('/api/cardcenter/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      const d = await res.json() as { submitted?: number; duplicate?: number; failed?: number; alreadyDone?: boolean; error?: string; rawError?: string };
      if (!res.ok || d.error) {
        setSubmitMsg(d.error ?? 'Submission failed');
      } else if (d.alreadyDone) {
        setSubmitMsg('All cards already submitted');
      } else {
        const parts = [];
        if (d.submitted) parts.push(`${d.submitted} submitted`);
        if (d.duplicate) parts.push(`${d.duplicate} already on file`);
        if (d.failed) parts.push(`${d.failed} failed${d.rawError ? `: ${d.rawError}` : ''}`);
        setSubmitMsg(parts.join(', '));
        const updated = await fetch(`/api/orders/${orderId}/gift-cards`).then(r => r.json());
        setCards(updated);
      }
    } catch (e) {
      setSubmitMsg(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function copyForCardCenter() {
    const text = cards.map(c => [c.merchant, c.value.toFixed(2), c.cardNumber, c.pin ?? ''].join(',')).join('\n');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function fallbackCopy(text: string) {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }

  // Group cards by merchant+value
  const groups = new Map<string, GiftCard[]>();
  for (const card of cards) {
    const key = groupKey(card);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(card);
  }

  const allSubmitted = cards.length > 0 && cards.every(c => c.ccSubmittedAt);
  const someUnsubmitted = cards.some(c => !c.ccSubmittedAt);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">Gift Cards</h3>
        {cards.length > 0 && (
          <div className="flex items-center gap-2">
            <button onClick={copyForCardCenter} className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 px-2 py-1 rounded transition-colors">
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button onClick={submitToCardCenter} disabled={submitting || allSubmitted}
              className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white px-2 py-1 rounded transition-colors">
              {submitting ? 'Submitting…' : allSubmitted ? '✓ Submitted' : someUnsubmitted ? 'Submit to CardCenter' : 'Submit to CardCenter'}
            </button>
          </div>
        )}
      </div>

      {submitMsg && (
        <p className={`text-xs px-2 py-1 rounded ${submitMsg.includes('failed') || submitMsg.includes('Failed') ? 'bg-red-900/40 text-red-300' : 'bg-green-900/40 text-green-300'}`}>
          {submitMsg}
        </p>
      )}

      {cards.length > 0 && (
        <div className="space-y-4">
          {Array.from(groups.entries()).map(([key, groupCards]) => {
            const unsubmitted = groupCards.filter(c => !c.ccSubmittedAt);
            const reserved = unsubmitted.length > 0 && unsubmitted[0].ccReservationId != null;
            return (
              <div key={key}>
                {/* Reservation status row — only relevant for unsubmitted cards */}
                {unsubmitted.length > 0 && (
                  <div className="flex items-center gap-2 mb-1">
                    {reserved ? (
                      <>
                        <span className="text-xs text-green-400">
                          Reserved #{unsubmitted[0].ccReservationId}
                          {unsubmitted[0].ccSubmissionId && (
                            <span className="text-gray-500 ml-1">· {unsubmitted[0].ccSubmissionId.slice(0, 8)}…</span>
                          )}
                        </span>
                        <button
                          onClick={() => clearReservation(unsubmitted)}
                          className="text-xs text-gray-600 hover:text-red-400 transition-colors ml-1"
                          title="Clear stale reservation link"
                        >
                          × Clear
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-yellow-600">No reservation ({unsubmitted.length} card{unsubmitted.length !== 1 ? 's' : ''} pending)</span>
                    )}
                  </div>
                )}


                <div className="rounded border border-gray-800 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-900 text-gray-500 uppercase">
                      <tr>
                        <th className="px-3 py-2 text-left">Merchant</th>
                        <th className="px-3 py-2 text-right">Value</th>
                        <th className="px-3 py-2 text-left">Card Number</th>
                        <th className="px-3 py-2 text-left">PIN</th>
                        <th className="px-3 py-2 text-center">CC</th>
                        <th className="px-3 py-2 text-left">CC ID</th>
                        <th className="px-3 py-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {groupCards.map(c => {
                        const show = revealed.has(c.id);
                        return (
                          <tr key={c.id} className="hover:bg-gray-900/40">
                            <td className="px-3 py-2 text-gray-300">{c.merchant}</td>
                            <td className="px-3 py-2 text-right text-green-400">{fmt(c.value)}</td>
                            <td className="px-3 py-2 font-mono text-gray-300 max-w-[8rem]">
                              <button onClick={() => toggleReveal(c.id)} className="hover:text-white transition-colors block max-w-full truncate text-left">
                                {show ? c.cardNumber : '••••••••••••'}
                              </button>
                            </td>
                            <td className="px-3 py-2 font-mono text-gray-400">
                              {c.pin ? (show ? c.pin : '••••') : '—'}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <button
                                onClick={() => toggleCcSubmitted(c.id, c.ccSubmittedAt)}
                                title={c.ccSubmittedAt ? `Submitted ${new Date(c.ccSubmittedAt).toLocaleDateString()} — click to unmark` : 'Not submitted — click to mark as sent'}
                                className="hover:opacity-70 transition-opacity"
                              >
                                {c.ccSubmittedAt ? <span className="text-green-400">✓</span> : <span className="text-gray-600">—</span>}
                              </button>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-gray-400">
                              {editingCcId === c.id ? (
                                <span className="flex items-center gap-1">
                                  <input
                                    autoFocus
                                    value={ccIdDraft}
                                    onChange={e => setCcIdDraft(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') saveCcGiftCardId(c.id); if (e.key === 'Escape') setEditingCcId(null); }}
                                    className="w-24 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-white focus:outline-none focus:border-blue-500"
                                  />
                                  <button onClick={() => saveCcGiftCardId(c.id)} className="text-green-400 hover:text-green-300">✓</button>
                                  <button onClick={() => setEditingCcId(null)} className="text-gray-500 hover:text-gray-300">✕</button>
                                </span>
                              ) : (
                                <button
                                  onClick={() => { setEditingCcId(c.id); setCcIdDraft(c.ccGiftCardId ?? ''); }}
                                  className="hover:text-white transition-colors"
                                  title="Click to edit CC gift card ID"
                                >
                                  {c.ccGiftCardId ?? <span className="text-gray-700">—</span>}
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button onClick={() => remove(c.id)} className="text-gray-600 hover:text-red-400 transition-colors">×</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {!reserved && unsubmitted.length > 0 && (
                  <ReservationPanel
                    cards={unsubmitted}
                    orderId={orderId}
                    onReserved={setCards}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {adding ? (
        <div className="bg-gray-900 border border-gray-700 rounded p-3 space-y-2">
          {ccBrands.length > 0 && (
            <datalist id="cc-brands">
              {ccBrands.map(b => <option key={b} value={b} />)}
            </datalist>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="Merchant (e.g. DoorDash)" list="cc-brands" value={form.merchant} onChange={e => setForm(f => ({ ...f, merchant: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500" />
            <input placeholder="Value (e.g. 50.00)" type="number" step="0.01" value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500" />
            <input placeholder="Card Number" value={form.cardNumber} onChange={e => setForm(f => ({ ...f, cardNumber: e.target.value }))}
              autoComplete="off" spellCheck={false}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-blue-500" />
            <input placeholder="PIN (optional)" value={form.pin} onChange={e => setForm(f => ({ ...f, pin: e.target.value }))}
              autoComplete="off" spellCheck={false}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-blue-500" />
          </div>
          <div className="flex gap-2">
            <button onClick={addCard} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors">Add</button>
            <button onClick={() => { setAdding(false); setForm({ merchant: '', value: '', cardNumber: '', pin: '' }); }}
              className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 px-3 py-1.5 rounded transition-colors">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 px-3 py-1.5 rounded-md transition-colors">
          + Add Gift Card
        </button>
      )}
    </div>
  );
}
