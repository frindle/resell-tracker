// Applies PayPal receipts to the user's orders. The database is passed in so a
// test can hand it a fake; lib/emailAutoImport.ts passes prisma.
//
// A receipt is done, and its email can go, only when its match was written to
// the order, the order already carries the same transaction id, or it waited
// out PAYPAL_WAIT_MS with nothing to write (given up: archived, logged as a
// count only). Anything else stays in the inbox for the next run.

import { matchPayPalReceipt, PAYPAL_WAIT_MS, type PayPalOrder } from './paypalMatch.ts';
import { planPayPalApply, type CardRef } from './paypalApply.ts';
import type { PaymentEmail, HeldEmail } from './emailAutoImportPlan.ts';

type OrderRow = Omit<PayPalOrder, 'platform'> & { platform: string | null; cardId: number | null };
type CardRow = { id: number; last4: string | null; lastFours: { last4: string | null }[] };

export type PayPalDb = {
  order: {
    findMany(args: unknown): Promise<OrderRow[]>;
    update(args: { where: { id: number }; data: { notes: string; cardId?: number } }): Promise<unknown>;
  };
  creditCard: { findMany(args: unknown): Promise<CardRow[]> };
};

export type PayPalLog = { log: (line: string) => void; error: (line: string) => void };

/** Returns the email ids that are done with (to be removed from the inbox); receipts to retry are pushed onto `held`. */
export async function applyPayments(
  db: PayPalDb,
  payments: PaymentEmail[],
  held: HeldEmail[],
  now: number = Date.now(),
  out: PayPalLog = { log: console.log, error: console.error },
): Promise<string[]> {
  const done: string[] = [];
  let gaveUp = 0;
  const byUser = new Map<number, PaymentEmail[]>();
  for (const p of payments) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
  for (const [uid, list] of byUser) {
    const [rows, cardRows] = await Promise.all([
      db.order.findMany({
        where: { userId: uid, cancelled: false },
        select: { id: true, platform: true, orderNumber: true, cost: true, taxAmount: true, shippingCost: true, orderDate: true, createdAt: true, notes: true, cancelled: true, cardId: true, locked: true },
      }),
      db.creditCard.findMany({ where: { userId: uid }, select: { id: true, last4: true, lastFours: { select: { last4: true } } } }),
    ]);
    const orders = rows.map(o => ({ ...o, platform: String(o.platform ?? '') }));
    const cards: CardRef[] = cardRows.map(c => ({ id: c.id, last4s: [c.last4, ...c.lastFours.map(l => l.last4)].filter((x): x is string => !!x) }));
    for (const p of list) {
      const m = matchPayPalReceipt(p.receipt, orders, { emailAt: p.date, now, waitMs: PAYPAL_WAIT_MS });
      try {
        if (m.action === 'done') {
          out.log(`[email-auto-paypal] action=done user=${uid}`);
          done.push(p.id);
        } else if (m.action === 'apply') {
          const o = orders.find(x => x.id === m.orderId)!;
          const a = planPayPalApply(p.receipt, o, cards);
          await db.order.update({ where: { id: o.id }, data: { notes: a.notes, ...(a.cardId != null ? { cardId: a.cardId } : {}) } });
          // Keep the next receipt in this run from matching the same order.
          o.notes = a.notes;
          if (a.cardId != null) o.cardId = a.cardId;
          out.log(`[email-auto-paypal] action=apply card=${a.outcome} user=${uid}`);
          done.push(p.id);
        } else if (m.action === 'give-up') {
          gaveUp++;
          done.push(p.id);
        } else {
          out.log(`[email-auto-paypal] action=hold reason=${m.reason} user=${uid}`);
          held.push({ id: p.id, userId: uid, platform: 'PayPal', kind: 'payment', reason: m.reason });
        }
      } catch (e) {
        // Left in the inbox; the next run tries again.
        out.error(`[email-auto-paypal] failed for user ${uid}: ${String(e).slice(0, 160)}`);
      }
    }
  }
  if (gaveUp) out.log(`[email-auto-paypal] action=give-up count=${gaveUp}`);
  return done;
}
