import { money } from '../ui';
import type { Txn } from './txnTypes';

const LINK_LABEL: Record<string, string> = {
  order_charge: 'order', order_refund: 'refund of return', transfer: 'transfer with', reversal_pair: 'charge and refund with',
  personal: 'personal', ignore: 'ignored', cashback: 'cashback for order', darkbloom: 'Darkbloom payout', cost: 'cost entry',
  payout: 'payout of order', payout_shortfall: 'shortfall of order',
};
// "Savings - 2022, 2026-11-27" for the other row of a transfer or pair; its id only when the list does not have it.
const peerText = (t: Txn, id: number) => { const p = t.peers?.[id]; return p ? `${p.accountName}, ${p.postedDate}` : `row #${id}`; };
// Who made a match: rules and auto matches get a badge (the Undo button is on every matched row).
const byLabel = (m: string) => (m.startsWith('rule:') ? `rule #${m.slice(5)}` : m.startsWith('auto:') ? 'auto' : null);

/** The status of a bank row: its match status, the suggestion in words, the orders it points at, who matched it and what it links to. Shared by the table and the review card. */
export default function TxnStatus({ t }: { t: Txn }) {
  const sg = t.matchStatus === 'suggested' ? t.suggestion : null;
  return (
    <div>{t.matchStatus}
      {sg?.kind === 'transfer' && <div className="text-xs text-gray-500">{t.amountCents < 0 ? 'transfer to' : 'transfer from'} {peerText(t, sg.txnId)}</div>}
      {sg?.kind === 'pair' && <div className="text-xs text-gray-500">charge and refund with {peerText(t, sg.txnId)}</div>}
      {sg?.kind === 'order' && <div className="text-xs text-gray-500">order{sg.orderIds.length > 1 ? 's' : ''}: {sg.orderIds.map(o => `#${o}`).join(', ')}</div>}
      {sg?.kind === 'split' && <div className="text-xs text-gray-500">one of several charges for order #{sg.orderId}{sg.subsets.length > 1 ? ' (two sets fit, pick one)' : ''}</div>}
      {sg?.kind === 'refund' && <div className="text-xs text-gray-500">refund of return{sg.returns.length > 1 ? 's' : ''}: {sg.returns.map(r => `#${r.returnId} (order #${r.orderId}${r.partial ? ', part of it' : ''})`).join(', ')}</div>}
      {sg?.kind === 'cashback' && <div className="text-xs text-gray-500">{sg.portal ? 'portal ' : ''}cashback for order{sg.options.length > 1 || sg.options[0].units.length > 1 ? 's' : ''}: {sg.options.map(o => o.units.map(u => `#${u.orderId}`).join('+')).join(' or ')}{sg.options.some(o => o.aggregate) ? ' (several orders, oldest first)' : ''}</div>}
      {sg?.kind === 'deposit' && <div className="text-xs text-gray-500">{sg.aliased ? 'known payee: ' : ''}payout for {sg.options.map(o => `${o.parts.map(p => `#${p.orderId}`).join('+')}${o.shortfallCents > 0 ? ` (short ${money(o.shortfallCents)})` : ''}`).join(' or ')}{sg.options.some(o => o.how === 'near') ? ' (near miss, check the difference)' : ''}</div>}
      {t.orders && Object.keys(t.orders).length > 0 && <div className="mt-1 space-y-0.5 max-w-xs">
        {Object.entries(t.orders).slice(0, 3).map(([id, o]) => (
          <a key={id} href={`/orders/${id}`} target="_blank" rel="noreferrer" title={o.items ?? undefined}
            className="block text-xs text-blue-300 hover:underline">
            #{id} {o.platform}{o.orderNumber ? ` ${o.orderNumber}` : ''} · {o.orderDate} · {money(o.totalCents)}{o.buyer ? ` · ${o.buyer}` : ''}
            {o.items && <span className="block text-gray-400 truncate">{o.items}</span>}
          </a>
        ))}
        {Object.keys(t.orders).length > 3 && <div className="text-xs text-gray-500">+{Object.keys(t.orders).length - 3} more orders</div>}
      </div>}
      {t.links.some(l => byLabel(l.matchedBy)) && <div className="text-xs text-blue-300">matched by {byLabel(t.links.find(l => byLabel(l.matchedBy))!.matchedBy)}</div>}
      {t.links.map(l => <div key={l.id} className="text-xs text-gray-500">{l.kind === 'transfer' ? (t.amountCents < 0 ? 'transfer to' : 'transfer from') : (LINK_LABEL[l.kind] ?? l.kind)}{l.refId ? (l.kind === 'transfer' || l.kind === 'reversal_pair' ? ` ${peerText(t, l.refId)}` : ` #${l.refId}`) : ''} {money(l.amountCents)}{l.note ? ` (${l.note})` : ''}</div>)}
    </div>
  );
}
