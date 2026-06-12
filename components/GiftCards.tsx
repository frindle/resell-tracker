'use client';

import { useEffect, useState } from 'react';

type GiftCard = { id: number; merchant: string; value: number; cardNumber: string; pin: string | null; ccSubmittedAt: string | null };

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default function GiftCards({ orderId }: { orderId: number }) {
  const [cards, setCards] = useState<GiftCard[]>([]);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ merchant: '', value: '', cardNumber: '', pin: '' });
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState('');

  useEffect(() => {
    fetch(`/api/orders/${orderId}/gift-cards`).then(r => r.json()).then(setCards);
  }, [orderId]);

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
        // Refresh cards to show updated ccSubmittedAt
        const updated = await fetch(`/api/orders/${orderId}/gift-cards`).then(r => r.json());
        setCards(updated);
      }
    } catch (e) {
      setSubmitMsg(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // CardCenter submission format: brand, value, code, PIN
  function copyForCardCenter() {
    const text = cards.map(c => [c.merchant, c.value.toFixed(2), c.cardNumber, c.pin ?? ''].join('\t')).join('\n');
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
        <div className="rounded border border-gray-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-900 text-gray-500 uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Merchant</th>
                <th className="px-3 py-2 text-right">Value</th>
                <th className="px-3 py-2 text-left">Card Number</th>
                <th className="px-3 py-2 text-left">PIN</th>
                <th className="px-3 py-2 text-center">CC</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {cards.map(c => {
                const show = revealed.has(c.id);
                return (
                  <tr key={c.id} className="hover:bg-gray-900/40">
                    <td className="px-3 py-2 text-gray-300">{c.merchant}</td>
                    <td className="px-3 py-2 text-right text-green-400">{fmt(c.value)}</td>
                    <td className="px-3 py-2 font-mono text-gray-300">
                      <button onClick={() => toggleReveal(c.id)} className="hover:text-white transition-colors">
                        {show ? c.cardNumber : '••••••••••••'}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-400">
                      {c.pin ? (show ? c.pin : '••••') : '—'}
                    </td>
                    <td className="px-3 py-2 text-center" title={c.ccSubmittedAt ? `Submitted ${new Date(c.ccSubmittedAt).toLocaleDateString()}` : 'Not submitted'}>
                      {c.ccSubmittedAt ? <span className="text-green-400">✓</span> : <span className="text-gray-600">—</span>}
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
      )}

      {adding ? (
        <div className="bg-gray-900 border border-gray-700 rounded p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="Merchant (e.g. Amazon)" value={form.merchant} onChange={e => setForm(f => ({ ...f, merchant: e.target.value }))}
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
