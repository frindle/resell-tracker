// Prisma-backed BooksStore. The journal is append-only: the only update ever
// issued against it is JournalEntry.reversedAt (markReversed).
import type { Prisma } from '@/app/generated/prisma/client';
import { prisma } from '../db';
import { CHART_BY_KEY, dynamicAccountDef } from './chart.ts';
import type {
  AccountRow, AccountType, AcctRef, Business, BooksStore, LedgerLineRow, PostedEntry, StoredLine,
} from './types.ts';

type Db = Prisma.TransactionClient;

const toRow = (a: { id: number; userId: number; code: string; name: string; type: string; business: string; scheduleCLine: string | null; systemKey: string | null; creditCardId: number | null; buyerId: number | null; loanId: number | null; active: boolean }): AccountRow => ({
  ...a, type: a.type as AccountType, business: a.business as Business,
});

export class PrismaStore implements BooksStore {
  private db: Db;
  private nested: boolean;
  constructor(db: Db = prisma as unknown as Db, nested = false) {
    this.db = db;
    this.nested = nested;
  }

  async transaction<T>(fn: (tx: BooksStore) => Promise<T>): Promise<T> {
    if (this.nested) return fn(this);
    return (prisma as unknown as { $transaction: <R>(f: (t: Db) => Promise<R>, o?: { timeout?: number }) => Promise<R> })
      .$transaction(t => fn(new PrismaStore(t, true)), { timeout: 30_000 });
  }

  async lockedMonths(userId: number): Promise<Set<string>> {
    const rows = await this.db.periodLock.findMany({ where: { userId } });
    return new Set(rows.map(r => r.month));
  }

  async listAccounts(userId: number): Promise<AccountRow[]> {
    return (await this.db.ledgerAccount.findMany({ where: { userId }, orderBy: { code: 'asc' } })).map(toRow);
  }

  async resolveAccount(userId: number, ref: AcctRef): Promise<AccountRow> {
    if (typeof ref === 'number') {
      const a = await this.db.ledgerAccount.findFirst({ where: { id: ref, userId } });
      if (!a) throw new Error(`unknown account id ${ref}`);
      return toRow(a);
    }
    const found = await this.db.ledgerAccount.findFirst({ where: { userId, systemKey: ref } });
    if (found) return toRow(found);
    let def: ReturnType<typeof dynamicAccountDef> | (NonNullable<ReturnType<typeof dynamicAccountDef>>) | undefined = CHART_BY_KEY.get(ref) as never;
    if (!def) {
      const m = /^(card|buyer|loan):(\d+)$/.exec(ref);
      if (!m) throw new Error(`unknown account ${ref}`);
      const id = Number(m[2]);
      const name = m[1] === 'card'
        ? (await this.db.creditCard.findUnique({ where: { id } }))?.name
        : m[1] === 'buyer'
          ? (await this.db.buyer.findUnique({ where: { id } }))?.name
          : (await this.db.loan.findUnique({ where: { id } }))?.name;
      def = dynamicAccountDef(ref, name ?? `#${id}`);
    }
    if (!def) throw new Error(`unknown account ${ref}`);
    const d = def as { key: string; code: string; name: string; type: string; business: string; line?: string; creditCardId?: number; buyerId?: number; loanId?: number };
    const created = await this.db.ledgerAccount.create({
      data: {
        userId, code: d.code, name: d.name, type: d.type, business: d.business, scheduleCLine: d.line ?? null,
        systemKey: d.key, creditCardId: d.creditCardId ?? null, buyerId: d.buyerId ?? null, loanId: d.loanId ?? null,
      },
    });
    return toRow(created);
  }

  async insertEntry(
    userId: number,
    e: { date: string; memo: string; source: string; sourceKey: string; contentHash: string; reversesId: number | null },
    lines: StoredLine[],
  ): Promise<number> {
    const row = await this.db.journalEntry.create({
      data: { userId, ...e, lines: { create: lines } },
    });
    return row.id;
  }

  async markReversed(entryId: number, at: Date): Promise<boolean> {
    const r = await this.db.journalEntry.updateMany({ where: { id: entryId, reversedAt: null }, data: { reversedAt: at } });
    return r.count === 1;
  }

  async livePosted(userId: number, prefix: string): Promise<PostedEntry[]> {
    const rows = await this.db.journalEntry.findMany({
      where: { userId, reversedAt: null, source: { not: 'reversal' }, sourceKey: { startsWith: prefix } },
      include: { lines: true },
      orderBy: { id: 'asc' },
    });
    return rows as unknown as PostedEntry[];
  }

  async ledgerLines(userId: number, opts: { from?: string; to?: string; orderIds?: number[] } = {}): Promise<LedgerLineRow[]> {
    const rows = await this.db.journalLine.findMany({
      where: {
        entry: { userId, ...(opts.from || opts.to ? { date: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}) },
        ...(opts.orderIds ? { orderId: { in: opts.orderIds } } : {}),
      },
      include: { entry: true, account: true },
      orderBy: { id: 'asc' },
    });
    return rows.map(l => ({
      entryId: l.entryId, date: l.entry.date, entryMemo: l.entry.memo, source: l.entry.source, sourceKey: l.entry.sourceKey,
      accountId: l.accountId, code: l.account.code, accountName: l.account.name, type: l.account.type as AccountType,
      systemKey: l.account.systemKey, business: (l.business ?? l.account.business) as Business,
      amountCents: l.amountCents, orderId: l.orderId, machineId: l.machineId, memo: l.memo,
    }));
  }

  async eventDates(orderIds: number[]): Promise<Map<number, Map<string, string>>> {
    const out = new Map<number, Map<string, string>>();
    for (let i = 0; i < orderIds.length; i += 500) {
      const rows = await this.db.orderEventDate.findMany({ where: { orderId: { in: orderIds.slice(i, i + 500) } } });
      for (const r of rows) {
        if (!out.has(r.orderId)) out.set(r.orderId, new Map());
        out.get(r.orderId)!.set(r.event, r.date);
      }
    }
    return out;
  }

  async stampEvent(orderId: number, event: string, date: string): Promise<void> {
    await this.db.orderEventDate.upsert({
      where: { orderId_event: { orderId, event } },
      create: { orderId, event, date },
      update: {},
    });
  }
}
