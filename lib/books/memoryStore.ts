// In-memory BooksStore, used by the unit tests (the Prisma store is the real one).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccountRow, AcctRef, BooksStore, LedgerLineRow, PostedEntry, PostedLine, StoredLine } from './types.ts';
import { CHART_BY_KEY, dynamicAccountDef } from './chart.ts';

export class MemoryStore implements BooksStore {
  accounts: AccountRow[] = [];
  entries: PostedEntry[] = [];
  locks = new Map<number, Set<string>>();
  events = new Map<string, string>(); // `${orderId}|${event}` -> date
  names: Record<string, string> = {};
  private nextAcct = 1;
  private nextEntry = 1;
  private nextLine = 1;

  // Like SQLite's single writer: top-level transactions run one at a time; a nested call (same async chain) joins.
  private txTail: Promise<unknown> = Promise.resolve();
  private txScope = new AsyncLocalStorage<boolean>();

  async transaction<T>(fn: (tx: BooksStore) => Promise<T>): Promise<T> {
    if (this.txScope.getStore()) return fn(this);
    const prev = this.txTail;
    let release!: () => void;
    this.txTail = new Promise<void>(r => { release = r; });
    await prev.catch(() => undefined);
    try {
      return await this.txScope.run(true, () => this.runTx(fn));
    } finally {
      release();
    }
  }

  private async runTx<T>(fn: (tx: BooksStore) => Promise<T>): Promise<T> {
    // Snapshot/rollback so a throw inside leaves nothing behind, like a real transaction.
    const snap = {
      accounts: this.accounts.map(a => ({ ...a })),
      entries: this.entries.map(e => ({ ...e, lines: e.lines.map(l => ({ ...l })) })),
      events: new Map(this.events),
      nextAcct: this.nextAcct, nextEntry: this.nextEntry, nextLine: this.nextLine,
    };
    try {
      return await fn(this);
    } catch (e) {
      this.accounts = snap.accounts; this.entries = snap.entries; this.events = snap.events;
      this.nextAcct = snap.nextAcct; this.nextEntry = snap.nextEntry; this.nextLine = snap.nextLine;
      throw e;
    }
  }

  async lockedMonths(userId: number): Promise<Set<string>> {
    return new Set(this.locks.get(userId) ?? []);
  }

  lock(userId: number, month: string) {
    const s = this.locks.get(userId) ?? new Set<string>();
    s.add(month);
    this.locks.set(userId, s);
  }

  addAccount(userId: number, a: Partial<AccountRow> & Pick<AccountRow, 'code' | 'name' | 'type'>): AccountRow {
    const row: AccountRow = {
      id: this.nextAcct++, userId, business: 'resell', scheduleCLine: null, systemKey: null,
      creditCardId: null, buyerId: null, loanId: null, active: true, ...a,
    };
    this.accounts.push(row);
    return row;
  }

  async resolveAccount(userId: number, ref: AcctRef): Promise<AccountRow> {
    if (typeof ref === 'number') {
      const a = this.accounts.find(x => x.id === ref && x.userId === userId);
      if (!a) throw new Error(`unknown account id ${ref}`);
      return a;
    }
    const found = this.accounts.find(x => x.userId === userId && x.systemKey === ref);
    if (found) return found;
    const def = CHART_BY_KEY.get(ref) ?? dynamicAccountDef(ref, this.names[ref] ?? ref);
    if (!def) throw new Error(`unknown account ${ref}`);
    return this.addAccount(userId, {
      code: def.code, name: def.name, type: def.type, business: def.business,
      scheduleCLine: def.line ?? null, systemKey: def.key,
      creditCardId: (def as { creditCardId?: number }).creditCardId ?? null,
      buyerId: (def as { buyerId?: number }).buyerId ?? null,
      loanId: (def as { loanId?: number }).loanId ?? null,
    });
  }

  async insertEntry(
    userId: number,
    e: { date: string; memo: string; source: string; sourceKey: string; contentHash: string; reversesId: number | null },
    lines: StoredLine[],
  ): Promise<number> {
    const id = this.nextEntry++;
    const pl: PostedLine[] = lines.map(l => ({ id: this.nextLine++, entryId: id, ...l }));
    this.entries.push({ id, userId, ...e, reversedAt: null, lines: pl });
    return id;
  }

  async markReversed(entryId: number, at: Date): Promise<boolean> {
    const e = this.entries.find(x => x.id === entryId);
    if (!e) throw new Error('no such entry');
    if (e.reversedAt != null) return false;
    e.reversedAt = at;
    return true;
  }

  async livePosted(userId: number, prefix: string): Promise<PostedEntry[]> {
    return this.entries.filter(e => e.userId === userId && e.source !== 'reversal' && e.reversedAt == null && e.sourceKey.startsWith(prefix));
  }

  async listAccounts(userId: number): Promise<AccountRow[]> {
    return this.accounts.filter(a => a.userId === userId);
  }

  async ledgerLines(userId: number, opts: { from?: string; to?: string; orderIds?: number[] } = {}): Promise<LedgerLineRow[]> {
    const out: LedgerLineRow[] = [];
    const ids = opts.orderIds ? new Set(opts.orderIds) : null;
    for (const e of this.entries) {
      if (e.userId !== userId) continue;
      if (opts.from && e.date < opts.from) continue;
      if (opts.to && e.date > opts.to) continue;
      for (const l of e.lines) {
        if (ids && (l.orderId == null || !ids.has(l.orderId))) continue;
        const a = this.accounts.find(x => x.id === l.accountId)!;
        out.push({
          entryId: e.id, date: e.date, entryMemo: e.memo, source: e.source, sourceKey: e.sourceKey,
          accountId: a.id, code: a.code, accountName: a.name, type: a.type, systemKey: a.systemKey,
          business: (l.business ?? a.business) as LedgerLineRow['business'],
          amountCents: l.amountCents, orderId: l.orderId, machineId: l.machineId, memo: l.memo,
        });
      }
    }
    return out;
  }

  async eventDates(orderIds: number[]): Promise<Map<number, Map<string, string>>> {
    const out = new Map<number, Map<string, string>>();
    const want = new Set(orderIds);
    for (const [k, date] of this.events) {
      const [oid, ...rest] = k.split('|');
      const id = Number(oid);
      if (!want.has(id)) continue;
      if (!out.has(id)) out.set(id, new Map());
      out.get(id)!.set(rest.join('|'), date);
    }
    return out;
  }

  async stampEvent(orderId: number, event: string, date: string): Promise<void> {
    const k = `${orderId}|${event}`;
    if (!this.events.has(k)) this.events.set(k, date);
  }

  /** Net balance (cents) of an account by systemKey across every line, reversals included. */
  balance(userId: number, systemKey: string): number {
    const a = this.accounts.find(x => x.userId === userId && x.systemKey === systemKey);
    if (!a) return 0;
    let sum = 0;
    for (const e of this.entries) for (const l of e.lines) if (l.accountId === a.id) sum += l.amountCents;
    return sum;
  }
}
