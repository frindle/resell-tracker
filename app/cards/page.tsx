'use client';

import { useEffect, useState } from 'react';

type MerchantRate = { id: number; merchant: string; pointsPerDollar: number };
type Card = {
  id: number;
  name: string;
  milesProgram: string | null;
  rewardsRate: number | null;
  basePointsPerDollar: number | null;
  merchantRates: MerchantRate[];
  spendYearType: string;
  spendYearResetMMDD: string | null;
  currentSpend: number;
};
type RateType = 'cashback' | 'points';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

export default function CardsPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [name, setName] = useState('');
  const [milesProgram, setMilesProgram] = useState('');
  const [rateType, setRateType] = useState<RateType>('cashback');
  const [rateValue, setRateValue] = useState('');
  const [spendYearType, setSpendYearType] = useState<'calendar' | 'cardmember'>('calendar');
  const [spendYearResetMMDD, setSpendYearResetMMDD] = useState('');
  const [editing, setEditing] = useState<Card | null>(null);
  const [saving, setSaving] = useState(false);

  const [openRates, setOpenRates] = useState<number | null>(null);
  const [newMerchant, setNewMerchant] = useState('');
  const [newPoints, setNewPoints] = useState('');

  function load() {
    fetch('/api/cards').then(r => r.json()).then(setCards);
  }

  useEffect(() => { load(); }, []);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    const v = rateValue.trim() !== '' ? parseFloat(rateValue) : null;
    const payload = {
      name: name.trim(),
      milesProgram: milesProgram.trim() || null,
      rewardsRate: rateType === 'cashback' ? v : null,
      basePointsPerDollar: rateType === 'points' ? v : null,
      spendYearType,
      spendYearResetMMDD: spendYearType === 'cardmember' ? spendYearResetMMDD.trim() || null : null,
    };
    if (editing) {
      await fetch(`/api/cards/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setEditing(null);
    } else {
      await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    setName('');
    setMilesProgram('');
    setRateValue('');
    setSpendYearType('calendar');
    setSpendYearResetMMDD('');
    setSaving(false);
    load();
  }

  async function remove(id: number) {
    if (!confirm('Delete this card?')) return;
    await fetch(`/api/cards/${id}`, { method: 'DELETE' });
    if (openRates === id) setOpenRates(null);
    load();
  }

  function startEdit(c: Card) {
    setEditing(c);
    setName(c.name);
    setMilesProgram(c.milesProgram ?? '');
    setSpendYearType(c.spendYearType === 'cardmember' ? 'cardmember' : 'calendar');
    setSpendYearResetMMDD(c.spendYearResetMMDD ?? '');
    if (c.basePointsPerDollar != null) {
      setRateType('points');
      setRateValue(String(c.basePointsPerDollar));
    } else {
      setRateType('cashback');
      setRateValue(c.rewardsRate != null ? String(c.rewardsRate) : '');
    }
  }

  function cancelEdit() {
    setEditing(null);
    setName('');
    setMilesProgram('');
    setRateValue('');
    setRateType('cashback');
    setSpendYearType('calendar');
    setSpendYearResetMMDD('');
  }

  async function addMerchantRate(cardId: number) {
    if (!newMerchant.trim() || !newPoints.trim()) return;
    await fetch('/api/cards/merchant-rates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId, merchant: newMerchant.trim(), pointsPerDollar: newPoints }),
    });
    setNewMerchant('');
    setNewPoints('');
    load();
  }

  async function removeMerchantRate(rateId: number) {
    await fetch(`/api/cards/merchant-rates/${rateId}`, { method: 'DELETE' });
    load();
  }

  function cardSummary(c: Card) {
    if (c.rewardsRate != null) return `${c.rewardsRate}% cashback`;
    if (c.basePointsPerDollar != null) return `${c.basePointsPerDollar}x base points`;
    return 'no base rate';
  }

  function spendLabel(c: Card) {
    if (c.spendYearType === 'cardmember' && c.spendYearResetMMDD) {
      return `Cardmember year (resets ${c.spendYearResetMMDD})`;
    }
    return `${new Date().getFullYear()} calendar year`;
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h1 className="text-2xl font-bold">Credit Cards</h1>
        <p className="text-gray-400 text-sm mt-1">Manage cards, cashback rates, and per-merchant miles rates</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-medium text-gray-300">{editing ? 'Edit Card' : 'Add Card'}</h2>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          className="input w-full"
          placeholder="Card name (e.g. Chase Sapphire)"
        />
        <input
          type="text"
          value={milesProgram}
          onChange={e => setMilesProgram(e.target.value)}
          className="input w-full"
          placeholder="Miles/points program (e.g. Chase UR, Amex MR) — optional"
        />
        <div className="flex gap-2 items-center">
          <div className="flex rounded-md overflow-hidden border border-gray-700 text-sm">
            <button
              type="button"
              onClick={() => setRateType('cashback')}
              className={`px-3 py-1.5 transition-colors ${rateType === 'cashback' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              Cashback %
            </button>
            <button
              type="button"
              onClick={() => setRateType('points')}
              className={`px-3 py-1.5 transition-colors ${rateType === 'points' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              Points ×
            </button>
          </div>
          <div className="relative flex-1">
            <input
              type="number"
              step={rateType === 'cashback' ? '0.1' : '0.5'}
              min="0"
              value={rateValue}
              onChange={e => setRateValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && save()}
              className="input w-full pr-8"
              placeholder={rateType === 'cashback' ? 'e.g. 2' : 'e.g. 3'}
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
              {rateType === 'cashback' ? '%' : '×'}
            </span>
          </div>
        </div>

        <div className="flex gap-2 items-center">
          <span className="text-sm text-gray-400 whitespace-nowrap">Spend year:</span>
          <div className="flex rounded-md overflow-hidden border border-gray-700 text-sm">
            <button
              type="button"
              onClick={() => setSpendYearType('calendar')}
              className={`px-3 py-1.5 transition-colors ${spendYearType === 'calendar' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              Calendar
            </button>
            <button
              type="button"
              onClick={() => setSpendYearType('cardmember')}
              className={`px-3 py-1.5 transition-colors ${spendYearType === 'cardmember' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              Cardmember
            </button>
          </div>
          {spendYearType === 'cardmember' && (
            <input
              type="text"
              value={spendYearResetMMDD}
              onChange={e => {
                let v = e.target.value.replace(/[^\d/]/g, '');
                if (/^\d{4}$/.test(v)) v = v.slice(0, 2) + '/' + v.slice(2);
                setSpendYearResetMMDD(v);
              }}
              className="input w-24 text-sm"
              placeholder="MM/DD"
              maxLength={5}
            />
          )}
        </div>

        <p className="text-xs text-gray-500">
          {rateType === 'cashback'
            ? 'Cashback % is used to calculate dollar earnings on orders.'
            : 'Base points multiplier applies at all merchants unless overridden below.'}
        </p>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving || !name.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm transition-colors">
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Card'}
          </button>
          {editing && (
            <button onClick={cancelEdit} className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-md text-sm transition-colors">
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {cards.length === 0 && <p className="text-gray-500 text-sm">No cards yet.</p>}
        {cards.map(c => (
          <div key={c.id} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{c.name}</span>
                  {c.milesProgram && (
                    <span className="text-xs bg-purple-900/40 text-purple-300 border border-purple-800/50 rounded-full px-2 py-0.5">{c.milesProgram}</span>
                  )}
                  <span className={`text-sm ${c.rewardsRate != null || c.basePointsPerDollar != null ? 'text-gray-400' : 'text-gray-600'}`}>
                    {cardSummary(c)}
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  <span className="text-gray-400 font-medium">{fmt(c.currentSpend)}</span>
                  <span className="ml-1">spent · {spendLabel(c)}</span>
                </div>
              </div>
              <div className="flex gap-3 items-center ml-3 shrink-0">
                {c.basePointsPerDollar != null && (
                  <button
                    onClick={() => setOpenRates(openRates === c.id ? null : c.id)}
                    className="text-gray-400 hover:text-white text-xs transition-colors"
                  >
                    Merchant rates {c.merchantRates.length > 0 ? `(${c.merchantRates.length})` : ''}
                  </button>
                )}
                <button onClick={() => startEdit(c)} className="text-gray-400 hover:text-white text-xs transition-colors">Edit</button>
                <button onClick={() => remove(c.id)} className="text-gray-500 hover:text-red-400 text-xs transition-colors">Remove</button>
              </div>
            </div>

            {openRates === c.id && (
              <div className="border-t border-gray-800 px-4 py-3 space-y-3">
                <p className="text-xs text-gray-500">Per-merchant rates override the base {c.basePointsPerDollar}× rate</p>
                <div className="flex flex-wrap gap-2">
                  {c.merchantRates.map(r => (
                    <span key={r.id} className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-full px-3 py-1 text-xs text-gray-300">
                      {r.merchant}: {r.pointsPerDollar}×
                      <button onClick={() => removeMerchantRate(r.id)} className="text-gray-500 hover:text-red-400 ml-1 leading-none">×</button>
                    </span>
                  ))}
                  {c.merchantRates.length === 0 && <span className="text-gray-600 text-xs">No overrides yet — base rate applies everywhere.</span>}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMerchant}
                    onChange={e => setNewMerchant(e.target.value)}
                    placeholder="Merchant (e.g. Amazon)"
                    className="input flex-1 text-sm"
                  />
                  <div className="relative w-24">
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={newPoints}
                      onChange={e => setNewPoints(e.target.value)}
                      placeholder="5"
                      className="input w-full pr-5 text-sm"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">×</span>
                  </div>
                  <button
                    onClick={() => addMerchantRate(c.id)}
                    disabled={!newMerchant.trim() || !newPoints.trim()}
                    className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
