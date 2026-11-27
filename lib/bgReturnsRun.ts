import { prisma } from '@/lib/db';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getAllReturnTasks } from '@/lib/buyinggroup';
import { getReturnableLines } from '@/lib/orderReturns';
import { parseTask, classifyTask, matchTask, isUntouchedSyncRow, AUTO_NOTE, trackingKey, type BgTask, type MatchableOrder } from '@/lib/bgReturns';

// Buying Group returns at parity with BFMR's: pulls the Returns page tasks, matches each to an order
// (exact tracking, then serial, then a SKU only one order carries), records a return and its status on the
// order, and shows it in the order's returns panel. The sync NEVER recalculates money (cost basis, sale price,
// member reward): a recorded row waits for a person, whose next change to the order's returns recomputes it.
// Until then an untouched sync row is not counted against the sale price either (lib/orderReturns.ts).
// It never touches a locked order, never deletes a row a person edited, and does nothing for a status it does not know. An "accepted" task is NOT a return: it is recorded with
// its payout effect only. Nothing is ever sent to BG, and no order or tracking number is submitted.

async function candidateOrders(userId: number, task: BgTask): Promise<MatchableOrder[]> {
  const tk = trackingKey(task.tracking);
  const or = [
    ...(tk ? [{ trackingNumbers: { contains: tk } }, { packages: { some: { trackingNumber: { contains: tk } } } }] : []),
    ...(task.sku ? [{ commitmentLinks: { some: { commitment: { itemId: task.sku } } } }] : []),
  ];
  if (!or.length) return [];
  const rows = await prisma.order.findMany({
    where: { userId, cancelled: false, OR: or },
    select: {
      id: true, trackingNumbers: true,
      packages: { select: { trackingNumber: true } },
      commitmentLinks: { select: { commitment: { select: { itemId: true } } } },
    },
    take: 50,
  });
  return rows.map(o => ({
    id: o.id,
    tracking: [...(o.trackingNumbers ?? '').split(/[,\s]+/).filter(Boolean), ...o.packages.map(p => p.trackingNumber)],
    skus: o.commitmentLinks.map(l => l.commitment.itemId).filter((s): s is string => !!s),
  }));
}

/** Saves one parsed task and keeps the order's return row in step. Returns what happened, for the log. */
export async function applyTask(userId: number, task: BgTask): Promise<'return' | 'accepted' | 'void' | 'other' | 'unmatched'> {
  const kind = classifyTask(task);
  const prior = await prisma.bgReturnTask.findUnique({ where: { userId_taskKey: { userId, taskKey: task.key } }, select: { orderId: true } });
  const list = await candidateOrders(userId, task);
  const owners = task.serial
    ? await prisma.bgReturnTask.findMany({ where: { userId, serial: task.serial, orderId: { not: null } }, select: { orderId: true }, take: 1 })
    : [];
  const serialOwner = new Map<string, number>(task.serial && owners[0]?.orderId != null ? [[task.serial, owners[0].orderId]] : []);
  const m = prior?.orderId != null ? { orderId: prior.orderId, by: 'tracking' as const } : matchTask(task, list, serialOwner);

  const data = {
    receiptId: task.receiptId, sku: task.sku, serial: task.serial, status: task.status, voided: task.voided,
    supportId: task.supportId, tracking: task.tracking, note: task.note, imageCount: task.imageCount,
    createdDt: task.createdDt, updatedDt: task.updatedDt, orderId: m?.orderId ?? null,
    matchedBy: prior?.orderId != null ? undefined : m?.by ?? null,
    effect: kind.kind === 'accepted' ? kind.effect : null,
    syncedAt: new Date(),
  };
  await prisma.bgReturnTask.upsert({
    where: { userId_taskKey: { userId, taskKey: task.key } },
    create: { userId, taskKey: task.key, ...data },
    update: data,
  });

  const key = `bg:${task.key}`;
  const existing = await prisma.orderReturn.findUnique({
    where: { externalKey: key },
    select: { id: true, orderId: true, status: true, refundAmount: true, returnTracking: true, notes: true, quantity: true, receivedAt: true, refundedAt: true, order: { select: { locked: true, returnedCost: true } } },
  });
  // An unknown or new status, or renamed fields: record the task above and change nothing else.
  if (kind.kind === 'other') return 'other';
  if (kind.kind !== 'return') {
    // Explicitly voided, or accepted (not a return): take back a row this sync made and nobody has touched.
    // A row on a locked order, or on one whose cost a person already recalculated with this row in it, stays.
    if (existing && !existing.order.locked && existing.order.returnedCost === 0 && isUntouchedSyncRow(existing)) {
      await prisma.orderReturn.delete({ where: { id: existing.id } });
    }
    return m || kind.kind !== 'accepted' ? kind.kind : 'unmatched';
  }
  if (!m) return 'unmatched';
  if (existing) {
    // The group's status moves a row nobody has edited forward; a locked order or an edited row is left as it is.
    if (!existing.order.locked && isUntouchedSyncRow(existing)) {
      await prisma.orderReturn.update({
        where: { id: existing.id },
        data: { groupStatus: task.status, supportId: task.supportId, status: kind.status },
      });
    }
    return 'return';
  }
  // Checked for every resolved order, however it was found (an earlier task, a serial, tracking or SKU):
  // a locked order's numbers are not touched and a cancelled order gets no row.
  const target = await prisma.order.findUnique({ where: { id: m.orderId }, select: { userId: true, locked: true, cancelled: true } });
  if (!target || target.userId !== userId || target.locked || target.cancelled) return 'return';
  const lines = await getReturnableLines(m.orderId);
  const skuLinks = task.sku
    ? await prisma.orderCommitmentLink.findMany({ where: { orderId: m.orderId, commitment: { itemId: task.sku } }, select: { id: true } })
    : [];
  const open = lines.filter(l => l.quantity - l.returnedQuantity > 0);
  const line = open.find(l => l.commitmentLinkId != null && skuLinks.some(s => s.id === l.commitmentLinkId)) ?? open[0];
  if (!line) return 'return'; // every unit is already recorded as returned
  await prisma.orderReturn.create({
    data: {
      orderId: m.orderId, bfmrLinkId: line.bfmrLinkId, commitmentLinkId: line.commitmentLinkId,
      itemName: line.itemName, trackingNumber: line.trackingNumber, quantity: 1, status: kind.status,
      requestedAt: task.createdDt && !Number.isNaN(Date.parse(task.createdDt)) ? new Date(task.createdDt) : new Date(),
      notes: `${AUTO_NOTE}${task.note ? `: ${task.note}` : ''}`,
      source: 'bg', externalKey: key, groupStatus: task.status, supportId: task.supportId,
    },
  });
  return 'return';
}

export async function syncBgReturns(userId: number): Promise<{ tasks: number; counts: Record<string, number> }> {
  if (!(await isBgConfigured(userId))) return { tasks: 0, counts: {} };
  const token = await getBgAccessToken(userId);
  const counts: Record<string, number> = {};
  let n = 0;
  for (const raw of await getAllReturnTasks(token)) {
    const t = parseTask(raw);
    if (!t) continue;
    n++;
    try {
      const r = await applyTask(userId, t);
      counts[r] = (counts[r] ?? 0) + 1;
    } catch (e) {
      counts.failed = (counts.failed ?? 0) + 1;
      console.warn('[bg-returns] task failed:', String(e).slice(0, 160));
    }
  }
  console.log(`[bg-returns] user ${userId}: ${n} tasks ${JSON.stringify(counts)}`);
  return { tasks: n, counts };
}
