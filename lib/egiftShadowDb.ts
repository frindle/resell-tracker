import { prisma } from '@/lib/db';
import { withKeyedLock } from '@/lib/keyedLock';
import { EGIFT_EXTENSION_TARGET } from '@/lib/egiftScrape';
import {
  egiftRunnerMode, dryRunEgiftPayload, onEgiftCommandEnded, compareEgiftRuns, readEgiftResult, egiftPayloadInfo, type EgiftComparison, type EndedCommand,
} from '@/lib/egiftRunner';

// prisma wiring for lib/egiftRunner.ts (shadow mode).

const dryJson = (orderId: number) => JSON.stringify(dryRunEgiftPayload(orderId));
const builtinJson = (orderId: number) => JSON.stringify({ orderId });

/** Called from the command PATCH route when a command first reaches done/failed. Never throws. */
export async function egiftCommandEnded(cmd: EndedCommand): Promise<void> {
  try {
    await withKeyedLock('egift-shadow', () => onEgiftCommandEnded(cmd, {
      mode: egiftRunnerMode(),
      hasDryRun: async orderId =>
        !!(await prisma.extensionCommand.findFirst({ where: { type: 'SCRAPE_EGIFT', payload: dryJson(orderId) }, select: { id: true } })),
      queueDryRun: async orderId => {
        await prisma.extensionCommand.create({ data: { type: 'SCRAPE_EGIFT', targetBrowser: EGIFT_EXTENSION_TARGET, payload: dryJson(orderId) } });
      },
      findBuiltinResult: async orderId =>
        (await prisma.extensionCommand.findFirst({
          where: { type: 'SCRAPE_EGIFT', payload: builtinJson(orderId), status: 'done' }, orderBy: { id: 'desc' }, select: { result: true },
        }))?.result ?? null,
      log: line => console.log(line),
    }));
  } catch {
    console.error('[egift-shadow] hook failed');
  }
}

/** The latest finished dry runs compared with their built-in run: counts and codes only. */
export async function egiftShadowResults(limit = 20): Promise<EgiftComparison[]> {
  const dry = await prisma.extensionCommand.findMany({
    where: { type: 'SCRAPE_EGIFT', status: { in: ['done', 'failed'] }, payload: { contains: '"dryRun":true' } },
    orderBy: { id: 'desc' }, take: limit, select: { payload: true, status: true, result: true },
  });
  const out: EgiftComparison[] = [];
  for (const d of dry) {
    const info = egiftPayloadInfo(d.payload);
    if (!info) continue;
    const built = (await prisma.extensionCommand.findFirst({
      where: { type: 'SCRAPE_EGIFT', payload: builtinJson(info.orderId), status: 'done' }, orderBy: { id: 'desc' }, select: { result: true },
    }))?.result ?? null;
    out.push(compareEgiftRuns(info.orderId, built ? readEgiftResult('done', built) : null, readEgiftResult(d.status, d.result)));
  }
  return out;
}
