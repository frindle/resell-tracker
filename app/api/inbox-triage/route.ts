import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { promptJobsEnv } from '@/lib/promptJobs';
import { TRIAGE_KEY } from '@/lib/inboxTriageRun';
import { safeIgnoreRule } from '@/lib/inboxTriage';
import { NextRequest } from 'next/server';

function parseFields(s: string | null): Record<string, string> {
  try {
    const v = JSON.parse(s ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const bad = (msg: string) => Response.json({ error: msg }, { status: 400 });
const DECISIONS: Record<string, string> = { keep: 'kept', needs_parser: 'needs_parser', dismiss: 'dismissed' };

export async function GET() {
  try {
    const userId = await getSessionUserId();
    if (!userId) return new Response('Unauthorized', { status: 401 });

    const [setting, found, rules] = await Promise.all([
      getSetting(null, TRIAGE_KEY),
      // Undecided first (null decision sorts first in SQLite ascending), then newest.
      prisma.inboxTriage.findMany({ orderBy: [{ decision: 'asc' }, { createdAt: 'desc' }], take: 100 }),
      prisma.inboxIgnoreRule.findMany({ orderBy: { createdAt: 'desc' } }),
    ]);
    return Response.json({
      enabled: setting?.value === 'on',
      configured: promptJobsEnv() !== null,
      rows: found.map(r => ({ ...r, fields: parseFields(r.fields) })),
      rules,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    if (!userId) return new Response('Unauthorized', { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Bad request');
    const { action, id, ruleId, on } = body as Record<string, unknown>;

    if (action === 'toggle') {
      if (typeof on !== 'boolean') return bad('on must be true or false');
      await upsertSetting(null, TRIAGE_KEY, on ? 'on' : 'off');
      return Response.json({ ok: true });
    }

    if (action === 'delete_rule') {
      if (typeof ruleId !== 'number' || !Number.isInteger(ruleId)) return bad('ruleId required');
      await prisma.inboxIgnoreRule.deleteMany({ where: { id: ruleId } });
      return Response.json({ ok: true });
    }

    const isRowAction = action === 'ignore_sender' || action === 'retry' || (typeof action === 'string' && Object.hasOwn(DECISIONS, action));
    if (!isRowAction) return bad('Unknown action');
    if (typeof id !== 'number' || !Number.isInteger(id)) return bad('id required');
    const row = await prisma.inboxTriage.findUnique({ where: { id } });
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });

    if (action === 'retry') {
      // The row stays, marked "retry"; the next run fetches the message by its id and submits it again.
      if (row.status !== 'failed') return bad('Only a failed row can be retried');
      await prisma.inboxTriage.update({
        where: { id },
        data: { status: 'retry', jobId: null, error: null, category: null, recommend: null, reason: null, ingestKind: null, fields: null, ruleFromDomain: null, ruleSubject: null },
      });
      return Response.json({ ok: true });
    }

    let decision = DECISIONS[action as string];
    if (action === 'ignore_sender') {
      decision = 'ignored';
      // The model's domain came from the mail body, so it may only narrow the rule, never widen it.
      const rule = safeIgnoreRule(row);
      if (!rule) return bad('No safe sender domain to ignore');
      const same = await prisma.inboxIgnoreRule.findFirst({ where: { fromDomain: rule.fromDomain, subjectContains: rule.subjectContains } });
      if (!same) await prisma.inboxIgnoreRule.create({ data: { fromDomain: rule.fromDomain, subjectContains: rule.subjectContains } });
    }
    await prisma.inboxTriage.update({ where: { id }, data: { decision, decidedAt: new Date() } });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
