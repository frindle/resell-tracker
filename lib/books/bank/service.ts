// Server glue for the bank feed: connect, daily sync, file import, matching, and links (BankMatch).
// Accept / ignore / personal / reset write links; with accounting.bankPosting on, the books are reconciled right after.
import { prisma, getSetting, upsertSetting } from '../../db';
import { encryptRequired, decryptRequired, hasEncryptionKey, EncryptionKeyMissingError } from '../../secrets';
import { formatOrderDateIso } from '../../formatOrderDate.ts';
import { exclusive } from '../exclusive.ts';
import { booksEnabled, reconcileInner } from '../service.ts';
import { bankPostingEnabled } from './posting.ts';
import { PrismaStore } from '../prismaStore.ts';
import { postEntry } from '../ledger.ts';
import { laDay } from '../dates.ts';
import { cents } from '../money.ts';
import { isMapped, accountRef, parseCashbackNote, cashbackNote } from '../bankPostings.ts';
import { COST_CATEGORIES } from '../chart.ts';
import { claimSetupToken, fetchAccounts, SimpleFinError, dateWindows, type ClientOpts } from './simplefin.ts';
import { pruneRequestLog, budgetAllows, syncRange, MIN_MANUAL_SYNC_GAP_MS } from './window.ts';
import { planIngest } from './dedupe.ts';
import { transferRefusal } from './transferPair.ts';
import { groupMerchants } from './merchants.ts';
import { parseOfx, looksLikeOfx, MAX_OFX_BYTES } from './ofx.ts';
import {
  suggestAll, closedTwinPairs, expectedChargeCents, notesShowPayPal, orderCovered, matchRules, suggestPortalCashback, allocateDeposit, depositAutoOption,
  type MatchPayout, type MatchGroupPayment, type DepositPart, type DepositOption, type MatchTxn, type MatchAccount, type MatchOrder, type MatchReturn, type MatchRecv, type CardLastFours, type CashbackOption,
} from '../match.ts';
import { closedOnRefusal, isPostClose, leftoverCents, leftoverMessage } from './closed.ts';
import { checkSplit, mergeLinks, type SplitPart } from './split.ts';
import { loadPayoutOrders, loadGroupPayments } from './payoutOrders.ts';
import { learnAlias, loadAliases, listAliases, setAlias } from './payouts.ts';
import { shortNote, parseShort } from '../payoutReview.ts';
import type { BankAcctIn, BankTxnIn, FeedError } from './types.ts';

const REQ_LOG_KEY = 'bank.simplefin.requests';

async function readLog(userId: number): Promise<number[]> {
  try { const v = JSON.parse((await getSetting(userId, REQ_LOG_KEY))?.value ?? '[]'); return Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'number') : []; } catch { return []; }
}

export { EncryptionKeyMissingError, hasEncryptionKey };

// ---- ingest ----

type Source = 'simplefin' | 'ofx' | 'csv';

async function ingestAccount(userId: number, connectionId: number | null, provider: string, source: Source, a: BankAcctIn, window: { windowStart: string; windowEnd: string } | null, forceAccountId?: number) {
  let acct = forceAccountId != null
    ? await prisma.bankAccount.findFirst({ where: { id: forceAccountId, userId } })
    : await prisma.bankAccount.findFirst({ where: { userId, provider, providerAccountId: a.providerAccountId } });
  if (forceAccountId != null && !acct) throw new Error('unknown account');
  if (!acct) {
    acct = await prisma.bankAccount.create({
      data: {
        userId, connectionId, provider, providerAccountId: a.providerAccountId, name: a.name, orgName: a.orgName, currency: a.currency,
        kind: a.kind, last4: a.last4, balanceCents: a.balanceCents, balanceDate: a.balanceDate,
      },
    });
  } else {
    // Never overwrite what the user set (links, last4 they corrected); refresh what the bank owns.
    await prisma.bankAccount.update({
      where: { id: acct.id },
      data: {
        ...(connectionId != null ? { connectionId } : {}),
        ...(source === 'simplefin' ? { name: a.name, orgName: a.orgName, currency: a.currency } : {}),
        ...(acct.last4 == null && a.last4 ? { last4: a.last4 } : {}),
        ...(a.balanceCents != null && (a.balanceDate ?? '') >= (acct.balanceDate ?? '') ? { balanceCents: a.balanceCents, balanceDate: a.balanceDate } : {}),
      },
    });
  }
  if (a.balanceCents != null && source !== 'csv') {
    const date = a.balanceDate ?? laDay(new Date());
    await prisma.statementBalance.upsert({
      where: { bankAccountId_date_source: { bankAccountId: acct.id, date, source } },
      create: { bankAccountId: acct.id, date, balanceCents: a.balanceCents, source },
      update: { balanceCents: a.balanceCents },
    });
  }
  const existing = await prisma.bankTransaction.findMany({
    where: { bankAccountId: acct.id },
    select: { id: true, providerTxnId: true, postedDate: true, pending: true, matchStatus: true, amountCents: true, description: true, transactedDate: true, noRule: true },
  });
  const plan = planIngest(existing, a.transactions, window);
  const data = (r: BankTxnIn) => ({
    postedDate: r.postedDate, transactedDate: r.transactedDate, amountCents: r.amountCents, description: r.description,
    payee: r.payee, memo: r.memo, pending: r.pending,
  });
  const statusOf = new Map(existing.map(e => [e.id, e]));
  // A posted row stored earlier that has links of its own keeps them: the pending row stays (it is not deleted) and we log it.
  let moves = plan.moves, deleteIds = plan.deleteIds;
  if (moves.length) {
    const owned = new Set((await prisma.bankMatch.findMany({ where: { userId, txnId: { in: moves.map(m => m.toId) } }, select: { txnId: true } })).map(l => l.txnId));
    const refused = moves.filter(m => owned.has(m.toId));
    if (refused.length) {
      console.warn(`bank ingest: kept ${refused.length} pending row(s) with links, their posted rows already have links`);
      const keep = new Set(refused.map(m => m.fromId));
      moves = moves.filter(m => !keep.has(m.fromId));
      deleteIds = deleteIds.filter(id => !keep.has(id));
    }
  }
  for (const u of plan.update) if (u.rekey) console.log(`[bank/ingest] pending ${u.id} -> ${u.id} (tier ${u.tier})`);
  for (const m of moves) console.log(`[bank/ingest] pending ${m.fromId} -> ${m.toId} (tier ${m.tier})`);
  if (plan.amountChanged.length) console.warn(`bank ingest: ${plan.amountChanged.length} linked row(s) changed amount when they posted, flagged in the Bank tab`);
  // One transaction: insert, update (rekey included), move links, delete the stale rows.
  const ops = [
    ...plan.insert.map(r => prisma.bankTransaction.create({ data: { userId, bankAccountId: acct!.id, providerTxnId: r.providerTxnId, source, ...data(r) } })),
    // Updates keep matchStatus and the links, so a pending row that posts stays matched. A rekey also takes the posted row's new id.
    ...plan.update.map(u => prisma.bankTransaction.update({ where: { id: u.id }, data: { ...data(u.row), ...(u.rekey ? { providerTxnId: u.row.providerTxnId } : {}) } })),
    // A pending row re-issued as a posted row stored earlier: its links (and its transfer partner's link back) and its
    // status and rule opt-out move there first, since deleting the pending row deletes its links.
    ...moves.flatMap(m => [
      prisma.bankMatch.updateMany({ where: { userId, txnId: m.fromId }, data: { txnId: m.toId } }),
      prisma.bankMatch.updateMany({ where: { userId, refId: m.fromId, kind: { in: ['transfer', 'reversal_pair'] } }, data: { refId: m.toId } }),
      prisma.bankTransaction.update({ where: { id: m.toId }, data: { matchStatus: statusOf.get(m.fromId)?.matchStatus ?? 'matched', suggestion: null, noRule: statusOf.get(m.fromId)?.noRule ?? false } }),
    ]),
    ...(deleteIds.length ? [prisma.bankTransaction.deleteMany({ where: { id: { in: deleteIds } } })] : []),
  ];
  if (ops.length) await prisma.$transaction(ops);
  return { accountId: acct.id, inserted: plan.insert.length, updated: plan.update.length, removed: deleteIds.length - moves.length, moved: moves.length, amountChanged: plan.amountChanged.length };
}

// ---- connect / sync ----

export async function connectSimpleFin(userId: number, setupToken: string, opts: ClientOpts = {}) {
  // Check the key BEFORE claiming: a Setup Token can only be claimed once, so a failure after the claim would lose it.
  if (!hasEncryptionKey()) throw new EncryptionKeyMissingError();
  const accessUrl = await claimSetupToken(setupToken, opts);
  const enc = encryptRequired(accessUrl);
  const existing = await prisma.bankConnection.findFirst({ where: { userId, provider: 'simplefin' } });
  const conn = existing
    ? await prisma.bankConnection.update({ where: { id: existing.id }, data: { accessUrlEnc: enc, lastError: null, lastErrors: null } })
    : await prisma.bankConnection.create({ data: { userId, provider: 'simplefin', accessUrlEnc: enc } });
  return conn.id;
}

export async function disconnect(userId: number) {
  await prisma.bankConnection.deleteMany({ where: { userId, provider: 'simplefin' } }); // accounts and rows stay (connectionId -> null)
}

export type SyncSummary = { inserted: number; updated: number; removed: number; moved: number; accounts: number; errors: FeedError[]; requests: number };

export function syncSimpleFin(userId: number, opts: ClientOpts & { now?: Date; manual?: boolean } = {}): Promise<SyncSummary> {
  return exclusive(userId, async () => {
    const now = opts.now ?? new Date();
    const conn = await prisma.bankConnection.findFirst({ where: { userId, provider: 'simplefin' } });
    if (!conn) throw new Error('no SimpleFIN connection');
    if (opts.manual && conn.lastSyncAt && now.getTime() - conn.lastSyncAt.getTime() < MIN_MANUAL_SYNC_GAP_MS) {
      throw new Error('synced a moment ago; SimpleFIN allows about 24 requests a day, try again in a few minutes');
    }
    const range = syncRange(conn.lastSyncAt, now);
    const nWindows = dateWindows(range.startDay, range.endDay).length;
    const log = pruneRequestLog(await readLog(userId), now.getTime());
    if (!budgetAllows(log, now.getTime(), nWindows)) throw new Error('SimpleFIN daily request budget (24) used up; try again later');
    let result;
    try {
      const accessUrl = decryptRequired(conn.accessUrlEnc);
      result = await fetchAccounts(accessUrl, range, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'sync failed';
      await prisma.bankConnection.update({ where: { id: conn.id }, data: { lastError: msg.slice(0, 500) } });
      if (e instanceof SimpleFinError || e instanceof EncryptionKeyMissingError) throw e;
      throw new Error(msg);
    }
    await upsertSetting(userId, REQ_LOG_KEY, JSON.stringify([...log, ...Array(result.requests).fill(now.getTime())]));
    const sum: SyncSummary = { inserted: 0, updated: 0, removed: 0, moved: 0, accounts: result.accounts.length, errors: result.errors, requests: result.requests };
    for (const a of result.accounts) {
      const r = await ingestAccount(userId, conn.id, 'simplefin', 'simplefin', a, { windowStart: range.startDay, windowEnd: range.endDay });
      sum.inserted += r.inserted; sum.updated += r.updated; sum.removed += r.removed; sum.moved += r.moved;
    }
    await prisma.bankConnection.update({
      where: { id: conn.id },
      data: { lastSyncAt: now, lastError: null, lastErrors: result.errors.length ? JSON.stringify(result.errors) : null },
    });
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return sum;
  });
}

export async function syncAllBankUsers(): Promise<void> {
  const rows = await prisma.bankConnection.findMany({ where: { provider: 'simplefin' }, select: { userId: true } });
  for (const r of rows) {
    try {
      if (!(await booksEnabled(r.userId))) continue;
      await syncSimpleFin(r.userId);
    } catch (e) { console.error('[books] bank sync failed for user', r.userId, e instanceof Error ? e.message : 'error'); }
  }
}

// ---- OFX / QFX upload ----

export async function importOfx(userId: number, bytes: Uint8Array, bankAccountId?: number) {
  if (bytes.length > MAX_OFX_BYTES) throw new Error(`file is larger than ${MAX_OFX_BYTES / 1024 / 1024} MB`);
  const text = Buffer.from(bytes).toString('utf8');
  if (!looksLikeOfx(text)) throw new Error('that does not look like an OFX or QFX file');
  const stmts = parseOfx(text);
  if (bankAccountId != null && stmts.length > 1) throw new Error('this file holds several accounts; import it without choosing one');
  return exclusive(userId, async () => {
    let inserted = 0, updated = 0;
    for (const s of stmts) {
      const a: BankAcctIn = {
        providerAccountId: s.providerAccountId, name: `${s.org ?? 'Imported'} ${s.kind === 'credit' ? 'card' : 'account'}${s.last4 ? ` ${s.last4}` : ''}`,
        orgName: s.org, currency: s.currency, kind: s.kind, last4: s.last4, balanceCents: s.balanceCents, balanceDate: s.balanceDate, transactions: s.transactions,
      };
      // Files are partial views: never delete anything (window null), and re-uploading changes nothing.
      const r = await ingestAccount(userId, null, 'ofx', 'ofx', a, null, bankAccountId);
      inserted += r.inserted; updated += r.updated;
    }
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return { accounts: stmts.length, inserted, updated };
  });
}

// ---- matching ----

async function runMatchingInner(userId: number) {
  const [allTxnRows, accts, orderRows, cards, chargeSums, refundSums, returnRows, cbOrders, cbLinks, rules, mappedAccts] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { userId, matchStatus: { in: ['unmatched', 'suggested'] }, account: { hidden: false } } }),
    prisma.bankAccount.findMany({ where: { userId }, select: { id: true, last4: true, creditCardId: true, ledgerAccountId: true, closedOn: true } }),
    prisma.order.findMany({ where: { userId, cardId: { not: null } } }), // cancelled ones too: they block a twin auto-accept
    prisma.creditCard.findMany({ where: { userId }, include: { lastFours: true } }),
    prisma.bankMatch.groupBy({ by: ['refId'], where: { userId, kind: 'order_charge' }, _sum: { amountCents: true } }),
    prisma.bankMatch.groupBy({ by: ['refId'], where: { userId, kind: 'order_refund' }, _sum: { amountCents: true } }),
    prisma.orderReturn.findMany({ where: { status: 'refunded', order: { userId, cardId: { not: null } } }, include: { order: { select: { cardId: true } } } }),
    prisma.order.findMany({ where: { userId, cancelled: false, OR: [{ cashbackAmount: { gt: 0 } }, { portalCashback: { gt: 0 } }, { amexOfferDollars: { gt: 0 } }] } }),
    prisma.bankMatch.findMany({ where: { userId, kind: 'cashback' } }),
    prisma.matchRule.findMany({ where: { userId, enabled: true }, orderBy: { id: 'asc' } }),
    prisma.bankAccount.findMany({ where: { userId, OR: [{ creditCardId: { not: null } }, { ledgerAccountId: { not: null } }] }, select: { id: true } }),
  ]);
  // Rows dated after a closed account's closedOn are kept for review but never auto-matched.
  const closedOnById = new Map(accts.map(a => [a.id, a.closedOn]));
  const txnRows = allTxnRows.filter(t => !isPostClose(closedOnById.get(t.bankAccountId), t.postedDate));
  const charged = new Map(chargeSums.map(g => [g.refId, g._sum.amountCents ?? 0]));
  const refunded = new Map(refundSums.map(g => [g.refId, g._sum.amountCents ?? 0]));
  const txns: MatchTxn[] = txnRows.map(t => ({ id: t.id, accountId: t.bankAccountId, postedDate: t.postedDate, amountCents: t.amountCents, description: t.description, matchStatus: t.matchStatus }));
  // Ship day per order: the earliest shippedAt among its tracking numbers (one query for all of them).
  const trackingOf = (notes: string | null) => String(notes ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const wanted = [...new Set(orderRows.flatMap(o => trackingOf(o.trackingNumbers)))];
  const shipRows = wanted.length ? await prisma.carrierDelivery.findMany({ where: { userId, trackingNumber: { in: wanted }, shippedAt: { not: null } }, select: { trackingNumber: true, shippedAt: true } }) : [];
  const shippedAt = new Map(shipRows.map(r => [r.trackingNumber, r.shippedAt!]));
  const shipDayOf = (o: { trackingNumbers: string | null }): string | null => {
    const ds = trackingOf(o.trackingNumbers).map(n => shippedAt.get(n)).filter((d): d is Date => d != null).sort((a, b) => a.getTime() - b.getTime());
    return ds.length ? laDay(ds[0]) : null;
  };
  const orders: MatchOrder[] = orderRows.map(o => ({
    id: o.id, platform: o.platform, orderNumber: o.orderNumber, orderDate: formatOrderDateIso(o.orderDate), cardId: o.cardId,
    cost: o.cost, shippingCost: o.shippingCost, insuranceCost: o.insuranceCost, taxAmount: o.taxAmount, subtotalAmount: o.subtotalAmount, cancelled: o.cancelled,
    linkedCents: charged.get(o.id) ?? 0, paypal: notesShowPayPal(o.notes), shipDay: shipDayOf(o),
  }));
  const lastFours: CardLastFours = new Map(cards.map(c => [c.id, new Set([...(c.last4 ? [c.last4] : []), ...c.lastFours.map(l => l.last4)])]));
  const taken = new Set(orders.filter(orderCovered).map(o => o.id));
  const events = await new PrismaStore().eventDates([...new Set(returnRows.map(r => r.orderId))]);
  const returns: MatchReturn[] = returnRows.map(r => ({
    id: r.id, orderId: r.orderId, cardId: r.order.cardId, refundCents: cents(r.refundAmount ?? 0),
    refundedDate: events.get(r.orderId)?.get(`refunded:${r.id}`) ?? (r.refundedAt ? laDay(r.refundedAt) : null),
    linkedCents: refunded.get(r.id) ?? 0,
  }));
  const takenReturnIds = new Set(returns.filter(r => (r.linkedCents ?? 0) >= r.refundCents).map(r => r.id));
  // Open cashback receivables per order: what the order carries less what bank links already cleared.
  const cleared = new Map<number, { cb: number; ax: number; portal: number }>();
  for (const l of cbLinks) {
    const p = parseCashbackNote(l.note, l.amountCents), c = cleared.get(l.refId) ?? { cb: 0, ax: 0, portal: 0 };
    cleared.set(l.refId, { cb: c.cb + p.cb, ax: c.ax + p.ax, portal: c.portal + p.portal });
  }
  const recvs: MatchRecv[] = cbOrders.map(o => {
    const c = cleared.get(o.id) ?? { cb: 0, ax: 0, portal: 0 };
    return {
      orderId: o.id, cardId: o.cardId, orderDate: formatOrderDateIso(o.orderDate),
      cbCents: Math.max(0, cents(o.cashbackAmount) - c.cb), axCents: Math.max(0, cents(o.amexOfferDollars ?? 0) - c.ax), pcCents: Math.max(0, cents(o.portalCashback ?? 0) - c.portal),
    };
  });
  // Deposits: credits on a mapped non-card account, only once the books are on.
  const depositAccountIds = new Set(accts.filter(a => a.ledgerAccountId != null && a.creditCardId == null).map(a => a.id));
  let payouts: MatchPayout[] | undefined, aliases: Map<string, number> | undefined, groupPayments: MatchGroupPayment[] | undefined;
  if (txns.some(t => t.amountCents > 0 && depositAccountIds.has(t.accountId)) && (await booksEnabled(userId))) {
    payouts = (await loadPayoutOrders(userId)).all.map(p => ({ orderId: p.orderId, buyerId: p.buyerId, paidDay: p.paidDay, paidCents: p.paidCents, openCents: p.openCents, payOpenCents: p.payOpenCents, groupPaid: p.groupPaid }));
    aliases = await loadAliases(userId);
    groupPayments = await loadGroupPayments(userId);
  }
  const sug = suggestAll(txns, accts as MatchAccount[], orders, lastFours, taken, { returns, takenReturnIds, recvs, depositAccountIds, payouts, aliases, groupPayments });

  // Step 8, user rules, on rows nothing else claimed. A rule acts at once (rules are always auto-accepted); portal rules
  // only narrow the row to portal cashback, which is suggested. A row the user undid is never re-ruled (noRule).
  const ruled = new Set<number>();
  let costMade = false;
  const noRule = new Set(txnRows.filter(t => t.noRule).map(t => t.id));
  const mappedIds = new Set(mappedAccts.map(a => a.id));
  const left = txns.filter(t => !sug.has(t.id) && !noRule.has(t.id));
  const hits = matchRules(left, rules, mappedIds);
  const hitTxn = new Map(txnRows.map(t => [t.id, t]));
  for (const h of hits) {
    const t = hitTxn.get(h.txnId)!, by = `rule:${h.ruleId}`, abs = Math.abs(t.amountCents);
    try {
      if (h.action === 'cashback_portal') {
        for (const c of suggestPortalCashback([left.find(x => x.id === t.id)!], recvs)) sug.set(c.txnId, { kind: 'cashback', portal: true, options: c.options });
        continue;
      }
      if (h.action === 'personal') await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'personal', refId: 0, amountCents: abs }], 'matched', undefined, by);
      else if (h.action === 'ignore') await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'ignore', refId: 0, amountCents: abs }], 'ignored', undefined, by);
      else if (h.action === 'darkbloom') await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'darkbloom', refId: 0, amountCents: abs }], 'matched', undefined, by);
      else if (h.action === 'cost') {
        const rule = rules.find(r => r.id === h.ruleId)!;
        const cost = await createCostFromRow(userId, t.id, { category: rule.costCategory ?? '', business: rule.business ?? 'resell' });
        await linkCost(userId, t.id, cost.id, abs, by);
        costMade = true;
      } else if (h.action.startsWith('transfer_to:') && h.partnerId != null) {
        await writeLinks(t.id, userId, [
          { txnId: t.id, kind: 'transfer', refId: h.partnerId, amountCents: abs },
          { txnId: h.partnerId, kind: 'transfer', refId: t.id, amountCents: abs },
        ], 'matched', undefined, by);
        ruled.add(h.partnerId);
      } else continue;
      ruled.add(t.id);
      await prisma.matchRule.update({ where: { id: h.ruleId }, data: { hits: { increment: 1 } } });
    } catch (e) { console.error('[books] rule', h.ruleId, 'failed on row', t.id, e instanceof Error ? e.message : 'error'); }
  }
  if (costMade) await reconcileInner(userId, new Date()); // a cost entry posts whether or not bank posting is on

  // Auto-accept (accounting.autoMatch, default off): only an exact cashback credit that fits one order.
  if ((await getSetting(userId, 'accounting.autoMatch'))?.value === 'true') {
    for (const [id, sg] of [...sug]) {
      if (sg.kind !== 'cashback' || sg.options.length !== 1 || sg.options[0].aggregate || ruled.has(id) || noRule.has(id)) continue;
      const t = hitTxn.get(id);
      if (!t) continue;
      try { await writeCashbackLinks(t.id, userId, sg.options[0], Math.abs(t.amountCents), 'auto:cashback'); sug.delete(id); ruled.add(id); } catch { /* stays suggested */ }
    }
  }
  // A closed set of interchangeable twins (N charges, N identical orders, nothing else in play) links one-to-one.
  if ((await getSetting(userId, 'accounting.autoMatch'))?.value === 'true') {
    for (const p of closedTwinPairs(txns, accts as MatchAccount[], orders, lastFours, taken)) {
      const sg = sug.get(p.txnId), t = hitTxn.get(p.txnId);
      if (!t || ruled.has(p.txnId) || noRule.has(p.txnId) || sg?.kind !== 'order' || sg.orderIds.length !== 1 || sg.orderIds[0] !== p.orderId) continue;
      try { await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'order_charge', refId: p.orderId, amountCents: Math.abs(t.amountCents) }], 'matched', undefined, 'auto:twin'); sug.delete(p.txnId); ruled.add(p.txnId); } catch { /* stays suggested */ }
    }
  }
  // Deposits auto-accept with a known payee (or a group's own payment of that amount) and one exact answer; the orders are
  // claimed one deposit at a time. A payment the group's API reported links whether or not autoMatch is on: there is
  // nothing for the user to check. Others need autoMatch.
  if (payouts) {
    const autoOn = (await getSetting(userId, 'accounting.autoMatch'))?.value === 'true';
    const claimed = new Set<number>();
    const openBy = new Map(payouts.map(p => [p.orderId, p]));
    for (const [id, sg] of [...sug]) {
      if (sg.kind !== 'deposit' || ruled.has(id) || noRule.has(id) || !(autoOn || sg.fromGroup)) continue;
      const opt = depositAutoOption(sg), t = hitTxn.get(id);
      if (!opt || !t || opt.parts.some(p => claimed.has(p.orderId))) continue;
      try {
        await writeDepositLinks(userId, t.id, Math.abs(t.amountCents), t.description, opt.parts.map(p => openBy.get(p.orderId)!), 'auto:deposit', opt.parts);
        for (const p of opt.parts) claimed.add(p.orderId);
        sug.delete(id); ruled.add(id);
      } catch { /* stays suggested */ }
    }
  }
  const ops = [];
  for (const t of txnRows) {
    if (ruled.has(t.id)) continue;
    const s = sug.get(t.id);
    const json = s ? JSON.stringify(s) : null;
    const status = s ? 'suggested' : 'unmatched';
    if (t.matchStatus !== status || t.suggestion !== json) ops.push(prisma.bankTransaction.update({ where: { id: t.id }, data: { matchStatus: status, suggestion: json } }));
  }
  if (ops.length) await prisma.$transaction(ops);
  return { suggested: sug.size, ruled: ruled.size };
}

export const runMatching = (userId: number) => exclusive(userId, () => runMatchingInner(userId));

export type MatchAction =
  | { action: 'accept'; orderId?: number; txnIds?: number[]; returnId?: number; orderIds?: number[] }
  /** Link by hand: a charge to an order (by id or order number), a credit to a return (by id, or the order's only open one). */
  | { action: 'link'; orderId?: number; orderNumber?: string; returnId?: number }
  | { action: 'ignore'; duplicate?: boolean }
  | { action: 'personal' }
  /** Pair by hand with another account's row: money out of one, the same amount into the other. */
  | { action: 'transfer'; partnerId: number }
  /** Make a cost entry from this debit (paid from the row's account) and link the row as `cost`. */
  | { action: 'cost'; category: string; business?: string; vendor?: string; purpose?: string; businessPct?: number }
  | { action: 'reset' }
  /** Split an open row into parts (order / return, Personal, cost entry) that add up to its amount. `parts` is checked by checkSplit. */
  | { action: 'split'; parts: unknown }
  /** Link a credit to payout orders by hand (any number of orders; the deposit may cover less than they are owed). */
  | { action: 'deposit'; orderIds: number[] }
  /** A Darkbloom payout piece: a credit on a mapped account. */
  | { action: 'darkbloom' }
  /** Classify the shortfall of a deposit linked to payouts. */
  | { action: 'shortfall'; choice: 'fee' | 'returns' | 'more' };

type Link = { txnId: number; kind: string; refId: number; amountCents: number; note?: string };
const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();

/** Re-run the reconcile (orders, costs, bank rows) when bank posting is on. Inside the caller's lock. */
async function postAfterChange(userId: number) {
  if (await bankPostingEnabled(userId)) await reconcileInner(userId, new Date());
}

/**
 * Accept / ignore / personal / reset one transaction. Writes BankMatch links (never the old matchedOrderId /
 * matchedTxnId columns). With accounting.bankPosting on, the books are reconciled right after, in the same lock.
 */
export async function applyMatchAction(userId: number, txnId: number, act: MatchAction) {
  return exclusive(userId, async () => {
    const t = await prisma.bankTransaction.findFirst({ where: { id: txnId, userId }, include: { account: { select: { id: true, creditCardId: true, ledgerAccountId: true } } } });
    if (!t) throw new HttpError(404, 'not found');
    const abs = Math.abs(t.amountCents);
    const open = (x: { matchStatus: string }) => x.matchStatus === 'unmatched' || x.matchStatus === 'suggested';
    if (act.action === 'reset') {
      if (await resetLinks(userId, t.id)) await reconcileInner(userId, new Date()); // a cost entry made from this row is voided: reverse it
    } else if (act.action === 'ignore') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      if (isMapped(t.account) && !act.duplicate) {
        throw new HttpError(409, 'this account is in your books, so ignoring a row would hide real money; use Personal, link it, or mark it a duplicate');
      }
      await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'ignore', refId: 0, amountCents: abs }], 'ignored', act.action === 'ignore' && act.duplicate ? 'duplicate' : undefined);
    } else if (act.action === 'personal') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'personal', refId: 0, amountCents: abs }], 'matched');
    } else if (act.action === 'transfer') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      const p = await prisma.bankTransaction.findFirst({ where: { id: act.partnerId, userId } });
      const why = transferRefusal(t, p);
      if (why) throw new HttpError(p && !open(p) ? 409 : 400, why);
      await writeLinks(t.id, userId, [
        { txnId: t.id, kind: 'transfer', refId: p!.id, amountCents: abs },
        { txnId: p!.id, kind: 'transfer', refId: t.id, amountCents: abs },
      ], 'matched');
    } else if (act.action === 'cost') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      if (t.amountCents >= 0) throw new HttpError(400, 'a cost entry comes from a debit');
      const cost = await createCostFromRow(userId, t.id, act);
      await linkCost(userId, t.id, cost.id, abs, 'user');
      await reconcileInner(userId, new Date()); // the cost entry posts whether or not bank posting is on
    } else if (act.action === 'split') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      await splitRow(userId, t, act.parts);
    } else if (act.action === 'darkbloom') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      if (t.amountCents <= 0) throw new HttpError(400, 'a Darkbloom payout is a credit');
      if (!isMapped(t.account)) throw new HttpError(409, 'this account is not in your books; map it first');
      await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'darkbloom', refId: 0, amountCents: abs }], 'matched');
    } else if (act.action === 'deposit') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      await linkDeposit(userId, t, act.orderIds, 'user');
    } else if (act.action === 'shortfall') {
      await classifyShortfall(userId, t.id, act.choice);
    } else if (act.action === 'link') {
      if (!open(t)) throw new HttpError(409, 'this transaction is already linked; undo it first');
      if (t.amountCents < 0) {
        const o = await findOrder(userId, act);
        if (o.cancelled) throw new HttpError(409, 'that order is cancelled');
        if (t.account.creditCardId != null && o.cardId != null && t.account.creditCardId !== o.cardId) {
          throw new HttpError(409, "that order is on a different card; change the order's card first");
        }
        await assertOrderOpen(userId, o.id);
        await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'order_charge', refId: o.id, amountCents: abs }], 'matched');
      } else if (t.amountCents > 0) {
        const returnId = act.returnId ?? await pickReturn(userId, (await findOrder(userId, act)).id, abs);
        await assertReturnRoom(userId, returnId, abs);
        await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'order_refund', refId: returnId, amountCents: abs }], 'matched');
      } else throw new HttpError(400, 'a zero row has nothing to link');
    } else {
      let s: { kind?: string; txnId?: number; orderIds?: number[]; orderId?: number; subsets?: number[][]; returns?: { returnId: number; orderId: number }[]; options?: CashbackOption[] } | null = null;
      try { s = t.suggestion ? JSON.parse(t.suggestion) : null; } catch { s = null; }
      if (t.matchStatus !== 'suggested' || !s) throw new HttpError(409, 'nothing suggested for this transaction');
      if ((s.kind === 'transfer' || s.kind === 'pair') && s.txnId != null) {
        const other = await prisma.bankTransaction.findFirst({ where: { id: s.txnId, userId } });
        if (!other || !open(other)) throw new HttpError(409, 'the other side is no longer open');
        if (Math.abs(other.amountCents) !== abs || Math.sign(other.amountCents) === Math.sign(t.amountCents)) throw new HttpError(400, 'the two sides must be equal and opposite');
        const kind = s.kind === 'transfer' ? 'transfer' : 'reversal_pair';
        await writeLinks(t.id, userId, [
          { txnId: t.id, kind, refId: other.id, amountCents: abs },
          { txnId: other.id, kind, refId: t.id, amountCents: abs },
        ], 'matched');
      } else if (s.kind === 'order' && s.orderIds?.length) {
        const pick = act.action === 'accept' ? (act.orderId ?? (s.orderIds.length === 1 ? s.orderIds[0] : null)) : null;
        if (pick == null || !s.orderIds.includes(pick)) throw new HttpError(400, 'choose one of the suggested orders');
        await assertOrderOpen(userId, pick);
        await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'order_charge', refId: pick, amountCents: abs }], 'matched');
      } else if (s.kind === 'split' && s.orderId != null && s.subsets?.length) {
        const pick = act.action === 'accept' && act.txnIds ? act.txnIds : s.subsets.length === 1 ? s.subsets[0] : null;
        if (!pick || !s.subsets.some(x => sameSet(x, pick))) throw new HttpError(400, 'choose one of the suggested sets of charges');
        await assertOrderOpen(userId, s.orderId);
        const rows = await prisma.bankTransaction.findMany({ where: { userId, id: { in: pick } } });
        if (rows.length !== pick.length || !rows.every(open)) throw new HttpError(409, 'one of those charges is no longer open');
        for (const r of rows) await writeLinks(r.id, userId, [{ txnId: r.id, kind: 'order_charge', refId: s.orderId, amountCents: Math.abs(r.amountCents) }], 'matched');
      } else if (s.kind === 'refund' && s.returns?.length) {
        const pick = act.action === 'accept' ? (act.returnId ?? (s.returns.length === 1 ? s.returns[0].returnId : null)) : null;
        if (pick == null || !s.returns.some(r => r.returnId === pick)) throw new HttpError(400, 'choose one of the suggested returns');
        await assertReturnRoom(userId, pick, abs);
        await writeLinks(t.id, userId, [{ txnId: t.id, kind: 'order_refund', refId: pick, amountCents: abs }], 'matched');
      } else if (s.kind === 'cashback' && s.options?.length) {
        const opts = s.options;
        const pick = act.action === 'accept' ? (act.orderId != null ? opts.find(o => o.units.some(u => u.orderId === act.orderId)) : opts.length === 1 ? opts[0] : undefined) : undefined;
        if (!pick) throw new HttpError(400, 'choose one of the suggested orders');
        await writeCashbackLinks(t.id, userId, pick, abs, 'user');
      } else if (s.kind === 'deposit' && (s.options as unknown as DepositOption[] | undefined)?.length) {
        const opts = s.options as unknown as DepositOption[];
        const ids = act.action === 'accept' ? act.orderIds : undefined;
        const pick = ids ? opts.find(o => sameSet(o.parts.map(p => p.orderId), ids)) : opts.length === 1 ? opts[0] : undefined;
        if (!pick) throw new HttpError(400, 'choose one of the suggested sets of orders');
        await linkDeposit(userId, t, pick.parts.map(p => p.orderId), 'user', pick.parts);
      } else throw new HttpError(409, 'nothing suggested for this transaction');
    }
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return { ok: true };
  });
}

/**
 * Split an open row: every part is checked first, then cost entries are made for the cost parts and all the links are written in
 * one transaction (a failure deletes the costs just made). An order part counts toward that order's linked charges; the row posts
 * only its Personal part (the orders and costs post themselves).
 */
async function splitRow(userId: number, t: { id: number; amountCents: number; account: { creditCardId: number | null } }, raw: unknown) {
  const credit = t.amountCents > 0;
  if (t.amountCents === 0) throw new HttpError(400, 'a zero row has nothing to split');
  const chk = checkSplit(raw, Math.abs(t.amountCents), credit, COST_CATEGORIES);
  if (!chk.ok) throw new HttpError(400, chk.error);
  const links: Link[] = [], costs: SplitPart[] = [];
  const orderLinks: { refId: number; amountCents: number }[] = [];
  for (const p of chk.parts) {
    if (p.kind === 'personal') links.push({ txnId: t.id, kind: 'personal', refId: 0, amountCents: p.cents });
    else if (p.kind === 'cost') costs.push(p);
    else if (!credit) {
      const o = await findOrder(userId, p);
      if (o.cancelled) throw new HttpError(409, `order #${o.id} is cancelled`);
      if (t.account.creditCardId != null && o.cardId != null && t.account.creditCardId !== o.cardId) throw new HttpError(409, `order #${o.id} is on a different card; change the order's card first`);
      await assertOrderOpen(userId, o.id);
      orderLinks.push({ refId: o.id, amountCents: p.cents });
    } else {
      const returnId = p.returnId ?? await pickReturn(userId, (await findOrder(userId, p)).id, p.cents);
      orderLinks.push({ refId: returnId, amountCents: p.cents });
    }
  }
  for (const l of mergeLinks(orderLinks.map(x => ({ ...x, kind: credit ? 'order_refund' : 'order_charge' })))) {
    if (credit) await assertReturnRoom(userId, l.refId, l.amountCents);
    links.push({ txnId: t.id, ...l });
  }
  const made: number[] = [];
  try {
    for (const c of costs) {
      const cost = await createCostFromRow(userId, t.id, { category: c.category!, business: c.business, vendor: c.vendor, purpose: c.purpose, businessPct: c.businessPct, amountCents: c.cents });
      made.push(cost.id);
      links.push({ txnId: t.id, kind: 'cost', refId: cost.id, amountCents: c.cents });
    }
    await writeLinks(t.id, userId, links, 'matched', undefined, 'user', true);
  } catch (e) {
    if (made.length) await prisma.costEntry.deleteMany({ where: { userId, id: { in: made } } }).catch(() => undefined);
    throw e;
  }
  if (made.length) await reconcileInner(userId, new Date()); // cost entries post whether or not bank posting is on
}

/** Link a credit to payout orders: checks the credit and the orders, shares the cash, learns the payee. Inside the caller's lock. */
async function linkDeposit(userId: number, t: { id: number; amountCents: number; description: string; account: { creditCardId: number | null; ledgerAccountId: number | null } }, orderIds: number[], by: string, exact?: DepositPart[]) {
  if (t.amountCents <= 0) throw new HttpError(400, 'a deposit is a credit');
  if (t.account.ledgerAccountId == null || t.account.creditCardId != null) throw new HttpError(409, 'this account is not a bank account in your books; map it first');
  const ids = [...new Set(orderIds ?? [])];
  if (ids.length === 0) throw new HttpError(400, 'choose the orders this deposit paid');
  const { all } = await loadPayoutOrders(userId);
  const by2 = new Map(all.map(p => [p.orderId, p]));
  const picks = ids.map(id => by2.get(id));
  // a negative part (a fee clawed back from an order an earlier deposit paid) needs only a paid order, whose open amount is spent
  const clawback = new Set((exact ?? []).filter(e => e.cents < 0).map(e => e.orderId));
  if (picks.some((p, i) => !p || (p.openCents <= 0 && !clawback.has(ids[i])))) throw new HttpError(409, 'one of those orders is not paid and waiting for a deposit');
  await writeDepositLinks(userId, t.id, t.amountCents, t.description, picks as MatchPayout[], by, exact);
}

/**
 * Payout links, one per order, adding up to the deposit; what the deposit leaves of an order's open amount goes in the link's
 * note as `short=` for the Shortfalls tab. Learns the payee when all the orders are one buyer's.
 */
async function writeDepositLinks(userId: number, txnId: number, abs: number, description: string, picks: { orderId: number; buyerId: number | null; openCents: number }[], by: string, exact?: DepositPart[]) {
  // `exact`: the suggestion's per-order cents (a group's own payment, or what the group actually paid per order); use it when it adds up to the deposit and fits each order's open amount.
  const fits = exact && exact.reduce((a, p) => a + p.cents, 0) === abs && exact.every(e => (picks.find(p => p.orderId === e.orderId)?.openCents ?? -1) >= e.cents);
  const parts = fits ? exact : allocateDeposit(abs, picks.map(p => ({ orderId: p.orderId, openCents: p.openCents })));
  if (!parts) throw new HttpError(409, `those orders are owed less than this deposit (${picks.reduce((a, p) => a + p.openCents, 0)} of ${abs} cents)`);
  const open = new Map(picks.map(p => [p.orderId, p.openCents]));
  await writeLinks(txnId, userId, parts.map(p => ({ txnId, kind: 'payout', refId: p.orderId, amountCents: p.cents, note: p.cents > 0 ? shortNote(open.get(p.orderId)! - p.cents) : undefined })), 'matched', undefined, by);
  const buyers = new Set(picks.map(p => p.buyerId));
  if (buyers.size === 1) await learnAlias(userId, description, [...buyers][0]);
}

/** Classify a deposit's shortfall (replaces an earlier choice): fee, returns, or more coming. Wrong match is the ordinary undo. */
async function classifyShortfall(userId: number, txnId: number, choice: string) {
  if (choice !== 'fee' && choice !== 'returns' && choice !== 'more') throw new HttpError(400, 'choose fee, returns or more coming');
  const links = await prisma.bankMatch.findMany({ where: { userId, txnId, kind: 'payout' } });
  const shorts = links.map(l => ({ orderId: l.refId, short: parseShort(l.note) })).filter(x => x.short > 0);
  if (shorts.length === 0) throw new HttpError(409, 'this deposit has no shortfall');
  await prisma.$transaction([
    prisma.bankMatch.deleteMany({ where: { userId, txnId, kind: 'payout_shortfall' } }),
    prisma.bankMatch.createMany({ data: shorts.map(x => ({ userId, txnId, kind: 'payout_shortfall', refId: x.orderId, amountCents: x.short, note: `shortfall:${choice}`, matchedBy: 'user' })) }),
  ]);
}

/**
 * Mark several open rows Personal at once (mixed accounts: most rows on a card can be personal). Rows already linked
 * are skipped. One matching and posting run at the end.
 */
export async function markPersonal(userId: number, txnIds: number[]) {
  return exclusive(userId, async () => {
    const rows = await prisma.bankTransaction.findMany({ where: { userId, id: { in: txnIds }, matchStatus: { in: ['unmatched', 'suggested'] } } });
    for (const r of rows) await writeLinks(r.id, userId, [{ txnId: r.id, kind: 'personal', refId: 0, amountCents: Math.abs(r.amountCents) }], 'matched');
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return { ok: true, marked: rows.length, skipped: txnIds.length - rows.length };
  });
}

/** An order can be paid by several charges; refuse only once the linked charges already cover it. */
async function assertOrderOpen(userId: number, orderId: number) {
  const o = await prisma.order.findFirst({ where: { id: orderId, userId } });
  if (!o) throw new HttpError(404, 'order not found');
  const g = await prisma.bankMatch.aggregate({ where: { userId, kind: 'order_charge', refId: orderId }, _sum: { amountCents: true } });
  const linked = g._sum.amountCents ?? 0;
  const mo = { id: o.id, platform: o.platform, orderNumber: o.orderNumber, orderDate: '', cardId: o.cardId, cost: o.cost, shippingCost: o.shippingCost, insuranceCost: o.insuranceCost, taxAmount: o.taxAmount, subtotalAmount: o.subtotalAmount, cancelled: o.cancelled, linkedCents: linked };
  if (linked > 0 && orderCovered(mo)) throw new HttpError(409, `that order is already paid in full by linked charges (${linked} of ${expectedChargeCents(mo).min} cents)`);
}

/** The user's order by id, or by its order number when exactly one order has it. */
async function findOrder(userId: number, act: { orderId?: number; orderNumber?: string }) {
  if (act.orderId != null) {
    const o = await prisma.order.findFirst({ where: { id: act.orderId, userId } });
    if (!o) throw new HttpError(404, 'order not found');
    return o;
  }
  const num = act.orderNumber?.trim();
  if (!num) throw new HttpError(400, 'give an order number or #id');
  const os = await prisma.order.findMany({ where: { userId, orderNumber: num }, take: 2 });
  if (os.length === 0) throw new HttpError(404, `no order has the number ${num}`);
  if (os.length > 1) throw new HttpError(409, `several orders have the number ${num}; use #id`);
  return os[0];
}

const refundLeft = async (userId: number, r: { id: number; refundAmount: number | null }) => {
  const g = await prisma.bankMatch.aggregate({ where: { userId, kind: 'order_refund', refId: r.id }, _sum: { amountCents: true } });
  return r.refundAmount == null ? null : cents(r.refundAmount) - (g._sum.amountCents ?? 0); // null: amount not entered yet
};

/** For a credit linked to an order: the order's return with room for it, preferring one where it is exactly what is left. */
async function pickReturn(userId: number, orderId: number, cents: number) {
  const rs = await prisma.orderReturn.findMany({ where: { orderId, order: { userId } }, orderBy: { id: 'asc' } });
  if (rs.length === 0) throw new HttpError(409, 'that order has no return; add the return on the order first');
  const room: { id: number; left: number | null }[] = [];
  for (const r of rs) {
    const left = await refundLeft(userId, r);
    if (left == null || left >= cents) room.push({ id: r.id, left });
  }
  const exact = room.filter(r => r.left === cents);
  if (exact.length === 1) return exact[0].id;
  if (room.length === 1) return room[0].id;
  if (room.length === 0) throw new HttpError(409, "that's more than what is left of that order's refunds");
  throw new HttpError(409, 'that order has several returns this could belong to; link it as r#<return id>');
}

/** A refund can arrive in parts; refuse a credit that would take the return past its refund amount. */
async function assertReturnRoom(userId: number, returnId: number, cents: number) {
  const r = await prisma.orderReturn.findFirst({ where: { id: returnId, order: { userId } } });
  if (!r) throw new HttpError(404, 'return not found');
  const left = await refundLeft(userId, r);
  if (left != null && cents > left) throw new HttpError(409, `that's more than what is left of the refund (${Math.max(left, 0)} cents)`);
}

/** Replace a row's links in one transaction and keep its status in step. Link sums must equal the row's amount. */
export async function writeLinks(txnId: number, userId: number, links: Link[], status: 'matched' | 'ignored', note?: string, matchedBy = 'user', multiOrder = false) {
  const byTxn = new Map<number, Link[]>();
  for (const l of links) (byTxn.get(l.txnId) ?? byTxn.set(l.txnId, []).get(l.txnId)!).push(l);
  const rows = await prisma.bankTransaction.findMany({ where: { userId, id: { in: [...byTxn.keys()] } }, select: { id: true, amountCents: true } });
  for (const r of rows) {
    if (!multiOrder && byTxn.get(r.id)!.filter(l => l.kind === 'order_charge').length > 1) throw new HttpError(400, 'a charge pays one order');
    const sum = byTxn.get(r.id)!.reduce((x, l) => x + l.amountCents, 0);
    if (sum !== Math.abs(r.amountCents)) throw new HttpError(400, `the links add up to ${sum} cents but the transaction is ${Math.abs(r.amountCents)}`);
  }
  void txnId;
  await prisma.$transaction([
    ...links.map(l => prisma.bankMatch.create({ data: { userId, txnId: l.txnId, kind: l.kind, refId: l.refId, amountCents: l.amountCents, note: l.note ?? note ?? null, matchedBy } })),
    ...rows.map(r => prisma.bankTransaction.update({ where: { id: r.id }, data: { matchStatus: status, suggestion: null } })),
  ]);
}

/**
 * Undo: delete the row's links and those of its partner (transfer / pair), back to unmatched. Charges for one order undo
 * one at a time: the order is then paid in part again and the rest is offered to other charges.
 */
async function resetLinks(userId: number, txnId: number): Promise<boolean> {
  const mine = await prisma.bankMatch.findMany({ where: { userId, txnId } });
  const costIds = mine.filter(l => l.kind === 'cost').map(l => l.refId);
  const affected = new Set<number>([txnId]);
  for (const l of mine) {
    if (l.kind === 'transfer' || l.kind === 'reversal_pair') affected.add(l.refId);
  }
  const ids = [...affected];
  // Undoing a rule or auto match must stick: the rows are kept out of the rules until the user links them again.
  const byRule = await prisma.bankMatch.count({ where: { userId, txnId: { in: ids }, OR: [{ matchedBy: { startsWith: 'rule:' } }, { matchedBy: { startsWith: 'auto:' } }] } });
  await prisma.$transaction([
    prisma.bankMatch.deleteMany({ where: { userId, txnId: { in: ids } } }),
    prisma.bankTransaction.updateMany({ where: { userId, id: { in: ids } }, data: { matchStatus: 'unmatched', suggestion: null, matchedOrderId: null, matchedTxnId: null, ...(byRule > 0 ? { noRule: true } : {}) } }),
    // A cost entry made from this row goes with the link (voided, so its entry is reversed), or undo then re-doing would count it twice.
    ...(costIds.length ? [prisma.costEntry.updateMany({ where: { userId, id: { in: costIds }, voidedAt: null }, data: { voidedAt: new Date() } })] : []),
  ]);
  return costIds.length > 0;
}

/** Link a credit to the cashback receivables of one option: one link per order, the note says which receivable it clears. */
async function writeCashbackLinks(txnId: number, userId: number, opt: CashbackOption, abs: number, by: string) {
  const links = opt.units.map(u => ({
    txnId, kind: 'cashback', refId: u.orderId, amountCents: u.cents,
    note: u.portal ? cashbackNote({ portal: true }) : cashbackNote({ cb: u.cb, ax: u.ax }),
  }));
  if (links.reduce((x, l) => x + l.amountCents, 0) !== abs) throw new HttpError(409, 'that suggestion no longer fits this credit');
  await writeLinks(txnId, userId, links, 'matched', undefined, by);
}

// ---- cost entries from bank rows ----

/** Link a row to the cost just made from it. If the link fails, delete the cost, or the next run would make a second one. */
async function linkCost(userId: number, txnId: number, costId: number, abs: number, by: string) {
  try {
    await writeLinks(txnId, userId, [{ txnId, kind: 'cost', refId: costId, amountCents: abs }], 'matched', undefined, by);
  } catch (e) {
    await prisma.costEntry.deleteMany({ where: { userId, id: costId } }).catch(() => undefined);
    throw e;
  }
}

/**
 * A cost entry for a debit on a mapped account, paid from that account's ledger account (a card posts to its card account).
 * The caller links the row as `cost`; the cost posts the expense, the bank row posts nothing.
 */
async function createCostFromRow(userId: number, txnId: number, o: { amountCents?: number; category: string; business?: string; vendor?: string; purpose?: string; businessPct?: number }) {
  const t = await prisma.bankTransaction.findFirst({ where: { id: txnId, userId }, include: { account: { select: { creditCardId: true, ledgerAccountId: true } } } });
  if (!t) throw new HttpError(404, 'not found');
  if (t.amountCents >= 0) throw new HttpError(400, 'a cost entry comes from a debit');
  if (!COST_CATEGORIES.includes(o.category)) throw new HttpError(400, 'unknown category');
  const pct = o.businessPct ?? 100;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'businessPct must be 0-100');
  let paidFromAccountId = t.account.ledgerAccountId;
  if (t.account.creditCardId != null) paidFromAccountId = (await new PrismaStore().resolveAccount(userId, `card:${t.account.creditCardId}`)).id;
  if (paidFromAccountId == null) throw new HttpError(409, 'this account is not in your books, so a cost has nothing to be paid from; map the account first');
  const row = await prisma.costEntry.create({
    data: {
      userId, business: o.business === 'shared' ? 'shared' : 'resell', date: t.postedDate, amountCents: o.amountCents ?? Math.abs(t.amountCents), category: o.category,
      businessPct: pct, paidFromAccountId, vendor: (o.vendor ?? t.description).trim().slice(0, 120) || null, purpose: o.purpose ? o.purpose.slice(0, 200) : null,
      note: `From bank row #${t.id}`,
    },
  });
  await prisma.auditLog.create({ data: { userId, actor: `user:${userId}`, action: 'create', entity: 'CostEntry', entityId: String(row.id), after: JSON.stringify({ ...row, fromBankRow: t.id }) } });
  return row;
}

// ---- rules ----

const RULE_ACTIONS = ['personal', 'ignore', 'cost', 'darkbloom', 'cashback_portal'];
export type RuleBody = {
  bankAccountId?: number | null; pattern?: string; isRegex?: boolean; sign?: string; minCents?: number | null; maxCents?: number | null;
  action?: string; costCategory?: string | null; business?: string | null; enabled?: boolean;
};

export async function listRules(userId: number) {
  return prisma.matchRule.findMany({ where: { userId }, orderBy: { id: 'asc' } });
}

async function checkRule(userId: number, r: Required<Pick<RuleBody, 'pattern' | 'isRegex' | 'sign' | 'action'>> & RuleBody) {
  const pattern = r.pattern.trim();
  if (!pattern || pattern.length > 200) throw new HttpError(400, 'the pattern must be 1-200 characters');
  if (r.isRegex) { try { new RegExp(pattern, 'i'); } catch { throw new HttpError(400, 'that is not a valid regular expression'); } }
  if (!['debit', 'credit', 'any'].includes(r.sign)) throw new HttpError(400, 'sign must be debit, credit or any');
  for (const v of [r.minCents, r.maxCents]) if (v != null && (!Number.isInteger(v) || v < 0)) throw new HttpError(400, 'min and max are whole cents, 0 or more');
  if (r.minCents != null && r.maxCents != null && r.minCents > r.maxCents) throw new HttpError(400, 'min is more than max');
  if (r.bankAccountId != null && !(await prisma.bankAccount.findFirst({ where: { id: r.bankAccountId, userId } }))) throw new HttpError(400, 'unknown account');
  if (r.action.startsWith('transfer_to:')) {
    const target = Number(r.action.slice('transfer_to:'.length));
    if (!Number.isInteger(target) || !(await prisma.bankAccount.findFirst({ where: { id: target, userId } }))) throw new HttpError(400, 'transfer target is not one of your accounts');
  } else if (!RULE_ACTIONS.includes(r.action)) throw new HttpError(400, 'unknown action');
  if (r.action === 'cost' && !COST_CATEGORIES.includes(r.costCategory ?? '')) throw new HttpError(400, 'a cost rule needs a category');
  if (r.business != null && !['resell', 'shared'].includes(r.business)) throw new HttpError(400, 'business must be resell or shared');
  return pattern;
}

export function createRule(userId: number, b: RuleBody) {
  return exclusive(userId, async () => {
    const full = { ...b, pattern: b.pattern ?? '', isRegex: b.isRegex === true, sign: b.sign ?? 'any', action: b.action ?? '' };
    const pattern = await checkRule(userId, full);
    const row = await prisma.matchRule.create({
      data: {
        userId, pattern, isRegex: full.isRegex, sign: full.sign, action: full.action, bankAccountId: b.bankAccountId ?? null, minCents: b.minCents ?? null,
        maxCents: b.maxCents ?? null, costCategory: full.action === 'cost' ? b.costCategory ?? null : null, business: b.business ?? null, enabled: b.enabled !== false,
      },
    });
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return row;
  });
}

export function updateRule(userId: number, id: number, b: RuleBody) {
  return exclusive(userId, async () => {
    const cur = await prisma.matchRule.findFirst({ where: { id, userId } });
    if (!cur) throw new HttpError(404, 'not found');
    const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as typeof cur;
    const pattern = await checkRule(userId, next);
    const row = await prisma.matchRule.update({
      where: { id },
      data: {
        pattern, isRegex: next.isRegex, sign: next.sign, action: next.action, bankAccountId: next.bankAccountId, minCents: next.minCents, maxCents: next.maxCents,
        costCategory: next.action === 'cost' ? next.costCategory : null, business: next.business, enabled: next.enabled,
      },
    });
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return row;
  });
}

export function deleteRule(userId: number, id: number) {
  return exclusive(userId, async () => {
    const r = await prisma.matchRule.deleteMany({ where: { id, userId } });
    if (r.count === 0) throw new HttpError(404, 'not found');
    return { ok: true };
  });
}

// ---- merchants review ----

const REVIEWED_KEY = 'books.reviewedMerchants';
async function readReviewed(userId: number): Promise<string[]> {
  try { const v = JSON.parse((await getSetting(userId, REVIEWED_KEY))?.value ?? '[]'); return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : []; } catch { return []; }
}

/** Open (unmatched or suggested) debits grouped by merchant, largest total first. Merchants marked "resell, keep" are left out unless `withKept`; each group says `kept`. */
export async function listMerchants(userId: number, withKept = false) {
  const [rows, accts, rules, reviewed] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { userId, matchStatus: { in: ['unmatched', 'suggested'] }, amountCents: { lt: 0 }, account: { hidden: false } }, select: { id: true, bankAccountId: true, postedDate: true, amountCents: true, description: true } }),
    prisma.bankAccount.findMany({ where: { userId }, select: { id: true, name: true, creditCardId: true, ledgerAccountId: true } }),
    prisma.matchRule.findMany({ where: { userId, enabled: true }, orderBy: { id: 'asc' } }),
    readReviewed(userId),
  ]);
  const kept = new Set(reviewed);
  const groups = groupMerchants(
    rows.map(r => ({ id: r.id, accountId: r.bankAccountId, postedDate: r.postedDate, amountCents: r.amountCents, description: r.description })),
    accts.map(a => ({ id: a.id, name: a.name, mapped: isMapped(a) })),
    rules,
  ).map(g => ({ ...g, kept: kept.has(g.key) }));
  return { groups: withKept ? groups : groups.filter(g => !g.kept) };
}

/** Mark a merchant "resell, keep" (it leaves the review list) or put it back. */
export function setMerchantKept(userId: number, key: string, keep: boolean) {
  return exclusive(userId, async () => {
    const k = key.trim().toLowerCase();
    if (!k || k.length > 100) throw new HttpError(400, 'the merchant key must be 1-100 characters');
    const cur = (await readReviewed(userId)).filter(x => x !== k);
    if (keep) cur.push(k);
    await upsertSetting(userId, REVIEWED_KEY, JSON.stringify(cur.slice(-2000)));
    return { ok: true, kept: keep };
  });
}

/** Ignore the open rows among txnIds. Rows on an account that is in the books are refused (all of them, nothing is written). */
export async function ignoreMany(userId: number, txnIds: number[]) {
  return exclusive(userId, async () => {
    const rows = await prisma.bankTransaction.findMany({ where: { userId, id: { in: txnIds }, matchStatus: { in: ['unmatched', 'suggested'] } }, include: { account: { select: { id: true, creditCardId: true, ledgerAccountId: true } } } });
    if (rows.some(r => isMapped(r.account))) throw new HttpError(409, 'some of these rows are on an account in your books, so ignoring them would hide real money; use Personal');
    for (const r of rows) await writeLinks(r.id, userId, [{ txnId: r.id, kind: 'ignore', refId: 0, amountCents: Math.abs(r.amountCents) }], 'ignored');
    await runMatchingInner(userId);
    await postAfterChange(userId);
    return { ok: true, marked: rows.length, skipped: txnIds.length - rows.length };
  });
}

// ---- transaction list filter ----

/**
 * Where clause for the Transactions list. hidePersonal drops rows linked as Personal, so personal spending stays
 * out of the way without being deleted (it still posts as an owner draw when bank posting is on). hidePending drops rows
 * the bank has not settled yet.
 */
export function txnListWhere(userId: number, f: { accountId?: number | null; status?: string | null; hidePersonal?: boolean; hidePending?: boolean }) {
  return {
    userId,
    account: { hidden: false },
    ...(f.accountId ? { bankAccountId: f.accountId } : {}),
    ...(f.status ? { matchStatus: f.status } : {}),
    ...(f.hidePersonal ? { links: { none: { kind: 'personal' } } } : {}),
    ...(f.hidePending ? { pending: false } : {}),
  };
}

// ---- learned payer names (Payers tab) ----

export const listPayees = (userId: number) => listAliases(userId);

/** Tie a payer name (from a deposit's description) to a buyer, or to none; the open deposits are re-suggested with it. */
export function setPayee(userId: number, description: string, buyerId: number | null) {
  return exclusive(userId, async () => {
    if (buyerId != null && !(await prisma.buyer.findUnique({ where: { id: buyerId } }))) throw new HttpError(400, 'no such buyer');
    const token = await setAlias(userId, description, buyerId);
    if (!token) throw new HttpError(400, 'no payer name in that description (too short, or a generic channel like Zelle)');
    await runMatchingInner(userId);
    return { ok: true, token };
  });
}

/** Forget a learned payer name; the open deposits are re-suggested without it. */
export function deletePayee(userId: number, id: number) {
  return exclusive(userId, async () => {
    const r = await prisma.payeeAlias.deleteMany({ where: { id, userId } });
    if (r.count === 0) throw new HttpError(404, 'not found');
    await runMatchingInner(userId);
    return { ok: true };
  });
}

// ---- statement balances ----

export async function setManualBalance(userId: number, accountId: number, date: string, balanceCents: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  if (!Number.isInteger(balanceCents)) throw new HttpError(400, 'balance must be whole cents');
  const acct = await prisma.bankAccount.findFirst({ where: { id: accountId, userId } });
  if (!acct) throw new HttpError(404, 'not found');
  await prisma.statementBalance.upsert({
    where: { bankAccountId_date_source: { bankAccountId: accountId, date, source: 'manual' } },
    create: { bankAccountId: accountId, date, balanceCents, source: 'manual' },
    update: { balanceCents },
  });
  return { ok: true };
}

export async function deleteManualBalance(userId: number, accountId: number, date: string) {
  const acct = await prisma.bankAccount.findFirst({ where: { id: accountId, userId } });
  if (!acct) throw new HttpError(404, 'not found');
  await prisma.statementBalance.deleteMany({ where: { bankAccountId: accountId, date, source: 'manual' } });
  return { ok: true };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** What the UI shows about the connection. Never includes the Access URL. */
export async function connectionStatus(userId: number) {
  const c = await prisma.bankConnection.findFirst({ where: { userId, provider: 'simplefin' }, select: { id: true, lastSyncAt: true, lastError: true, lastErrors: true } });
  let errors: FeedError[] = [];
  try { errors = c?.lastErrors ? JSON.parse(c.lastErrors) : []; } catch { errors = []; }
  return {
    encryptionConfigured: hasEncryptionKey(),
    connection: c ? { id: c.id, lastSyncAt: c.lastSyncAt, lastError: c.lastError, errors } : null,
  };
}

// ---- closed accounts ----

/** Mark an account closed on a day, or reopen it (null). Refused when the day is before the last posted row. History, links and postings stay. */
export function setAccountClosed(userId: number, accountId: number, closedOn: string | null) {
  return exclusive(userId, async () => {
    const a = await prisma.bankAccount.findFirst({ where: { id: accountId, userId } });
    if (!a) throw new HttpError(404, 'not found');
    if (closedOn !== null) {
      const last = await prisma.bankTransaction.findFirst({ where: { bankAccountId: a.id, pending: false }, orderBy: { postedDate: 'desc' }, select: { postedDate: true } });
      const refusal = closedOnRefusal(closedOn, last?.postedDate ?? null);
      if (refusal) throw new HttpError(400, refusal);
    }
    await prisma.bankAccount.update({ where: { id: a.id }, data: { closedOn } });
    // Reopening puts the rows that were held out back in play; closing moves the cutoff.
    await runMatchingInner(userId);
    return { ok: true };
  });
}

/** For a closed account: what is left in it (cents) and the message to show, or nulls when it is open, zero or unknown. */
export async function closedLeftover(userId: number, accountId: number) {
  const a = await prisma.bankAccount.findFirst({ where: { id: accountId, userId } });
  if (!a || !a.closedOn) return { leftoverCents: null as number | null, message: null as string | null };
  const rows = await prisma.bankTransaction.findMany({ where: { bankAccountId: a.id, postedDate: { gt: a.balanceDate ?? '9999-99-99' } }, select: { postedDate: true, amountCents: true, pending: true } });
  const c = leftoverCents(a.balanceCents, a.balanceDate, rows, a.closedOn);
  return { leftoverCents: c, message: leftoverMessage(c) };
}

/**
 * Settle what is left in a closed, mapped account as a write-off: one journal entry (source `closed:<id>`) moves it to
 * Other expenses, and a manual zero balance is recorded at closedOn. A transfer out needs no special path: pair the two rows
 * with the existing transfer link.
 */
export function writeOffClosedBalance(userId: number, accountId: number) {
  return exclusive(userId, async () => {
    const a = await prisma.bankAccount.findFirst({ where: { id: accountId, userId } });
    if (!a || !a.closedOn) throw new HttpError(404, 'not a closed account');
    const ref = accountRef(a);
    if (ref == null) throw new HttpError(409, 'this account is not mapped to a card or ledger account, so there is nothing in the books to write off');
    const { leftoverCents: left } = await closedLeftover(userId, a.id);
    if (left == null || left === 0) throw new HttpError(409, 'nothing is left in this account');
    const lines = [{ account: ref, amountCents: -left, business: 'shared' as const }, { account: 'exp_other', amountCents: left, business: 'shared' as const }];
    const store = new PrismaStore();
    const key = `closed:${a.id}`;
    const live = (await store.livePosted(userId, key)).filter(e => e.sourceKey === key);
    if (live.length) throw new HttpError(409, 'the balance was already written off');
    await postEntry(store, userId, { date: a.closedOn, memo: `Write off the balance left in closed account #${a.id}`, source: 'manual', sourceKey: key, contentHash: key, lines });
    await prisma.statementBalance.upsert({
      where: { bankAccountId_date_source: { bankAccountId: a.id, date: a.closedOn, source: 'manual' } },
      create: { bankAccountId: a.id, date: a.closedOn, balanceCents: 0, source: 'manual' },
      update: { balanceCents: 0 },
    });
    await prisma.bankAccount.update({ where: { id: a.id }, data: { balanceCents: 0, balanceDate: a.closedOn } });
    return { ok: true, writtenOffCents: left };
  });
}
