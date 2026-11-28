// The "needs your action" lines of the daily digest (see lib/digestLines.ts): one line per group (dispute with the
// group, manual handling, review) with the count by reason, the biggest orders by id, "and N more" and the page
// to open. The queue turns away the whole POST for a line with an amount, an order number or an @, so a line carries
// internal order ids, group names, ages and counts only; the amounts only set the order of the list.

import { cutLine, lineLooksPrivate, MAX_LINE_CHARS } from './digestPrivate.ts';
import { ACTION_GROUPS, type ActionCode, type ActionGroup, type ActionGroups, type ActionItem } from './orderActions.ts';

/** Orders named on a group's line before "and N more". */
export const ACTION_ITEMS_PER_GROUP = 10;

const TITLE: Record<ActionGroup, string> = {
  dispute: 'Dispute with the group',
  manual: 'Needs handling by hand',
  review: 'Needs a look',
};

const CODE_LABEL: Record<ActionCode, string> = {
  paid_below_expected: 'paid below expected',
  buyer_mismatch: 'wrong group paid',
  deposit_short: 'deposit short',
  overdue: 'overdue',
  delivered_not_credited: 'delivered, not credited',
  tracking_not_uploaded: 'tracking not uploaded',
  delivery_exception: 'delivery problem',
  no_buyer: 'no group',
  below_cost: 'below cost',
  rejected_items: 'rejected items',
  stale_return: 'return open',
};

/** Where to act on each group, as a path on the app (the /orders filters take several values). */
function linkFor(group: ActionGroup, items: ActionItem[]): string {
  if (group === 'dispute') return '/orders?status=partial,overdue';
  if (group === 'manual') return '/orders?status=needs_info';
  return items.every(i => i.code === 'paid_below_expected') ? '/orders?status=partial' : '/orders?status=returns';
}

function countsOf(items: ActionItem[]): string {
  const n = new Map<ActionCode, number>();
  for (const i of items) n.set(i.code, (n.get(i.code) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, k]) => `${CODE_LABEL[c]} ${k}`).join(', ');
}

function itemText(i: ActionItem): string {
  const who = [i.platform, i.group].filter(Boolean).join(' ');
  return `#${i.orderId} (${who ? `${who}, ` : ''}${i.ageDays}d)`;
}

/** Lines the three groups share (one each at least; the spare ones go to the first groups, so a long list is not cut to three names). */
export const ACTION_LINE_BUDGET = 6;

/** The group's lines, with at most `maxLines` of them: counts first, then as many of the biggest orders as fit, then the page. */
function linesFor(group: ActionGroup, items: ActionItem[], maxLines: number): string[] {
  const head = `${TITLE[group]}: ${items.length} ${items.length === 1 ? 'order' : 'orders'} (${countsOf(items)}).`;
  const link = linkFor(group, items);
  const tail = (left: number) => `${left > 0 ? ` and ${left} more` : ''}. ${link}`;
  const reserve = Array.from(tail(items.length)).length;
  const out: string[] = [];
  let cur = `${head} Biggest:`;
  let used = 0;
  for (const it of items.slice(0, ACTION_ITEMS_PER_GROUP)) {
    const piece = ` ${itemText(it)},`;
    const last = out.length === maxLines - 1;
    if (Array.from(cur + piece).length + (last ? reserve : 0) > MAX_LINE_CHARS) {
      if (last) break;
      out.push(cur.replace(/,$/, ''));
      cur = `Also:`;
    }
    cur += piece;
    used++;
  }
  out.push(`${cur.replace(/,$/, '')}${tail(items.length - used)}`);
  return out;
}

/**
 * Lines for the non-empty groups, the biggest orders packed in as far as the line limit and the queue's privacy rule
 * allow (fewer are named, down to none, rather than lose the counts). Empty when nothing needs action.
 */
export function buildActionLines(g: ActionGroups): string[] {
  const active = ACTION_GROUPS.filter(k => g[k].length > 0);
  let spare = Math.max(0, ACTION_LINE_BUDGET - active.length);
  const lines: string[] = [];
  for (const group of active) {
    const items = g[group];
    // Extra lines only where the first would not name every order.
    const extra = Math.min(spare, Math.max(0, Math.ceil(Math.min(items.length, ACTION_ITEMS_PER_GROUP) / 5) - 1));
    spare -= extra;
    const made = linesFor(group, items, 1 + extra);
    if (made.every(l => !lineLooksPrivate(cutLine(l)))) { lines.push(...made); continue; }
    // A name the queue refuses: counts and page only.
    const plain = `${TITLE[group]}: ${items.length} ${items.length === 1 ? 'order' : 'orders'} (${countsOf(items)}). ${linkFor(group, items)}`;
    lines.push(lineLooksPrivate(cutLine(plain)) ? cutLine(`${TITLE[group]}: ${items.length}.`) : plain);
  }
  return lines;
}
