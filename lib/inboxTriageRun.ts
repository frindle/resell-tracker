import { simpleParser } from 'mailparser';
import { prisma, getSetting } from '@/lib/db';
import { fetchCloudflareRaw, type CloudflareCreds, type ParsedCache } from '@/lib/emailCloudflare';
import { htmlToText, plainTextWithMarkup } from '@/lib/emailParse';
import { promptJobsEnv, submitPromptJob, getPromptJob } from '@/lib/promptJobs';
import { TRIAGE_SYSTEM, findIgnoreRule, parseTriageResult, redactForTriage, senderDomain, submitErrorKind, triageRef } from '@/lib/inboxTriage';

// Sends each message the app did not recognize, once and redacted, to the home
// lab's local model (lib/promptJobs.ts) and stores the answer for a person to act
// on (/import?tab=triage). Off unless the global setting inbox_triage is "on" and
// the queue is configured. It never deletes, moves or imports mail, and logs only
// row ids and statuses, never a subject or text.

export const TRIAGE_KEY = 'inbox_triage';
const GIVE_UP_MS = 48 * 60 * 60 * 1000;

// Everything here shares one time budget, so a queue that is down or slow cannot hold up the mail import.
type Opts = { maxSubmit: number; maxPoll: number; budgetMs: number };

type PromptReq = Parameters<typeof submitPromptJob>[1];
type Prepared = { base: { fromDomain: string; subject: string; receivedAt: Date | null }; domain: string; subject: string; req: PromptReq };

// Fetch, parse and redact one message. Throws when it cannot be read; null when the mail is gone.
async function prepare(cf: CloudflareCreds, id: string): Promise<Prepared | null> {
  const raw = await fetchCloudflareRaw(cf, id);
  if (!raw) return null;
  const parsed = await simpleParser(raw);
  const subject = parsed.subject ?? '';
  // The address, not the display text: "service@paypal.com" <x@evil.example> is evil.example.
  const domain = senderDomain(parsed.from?.value?.[0]?.address ?? '');
  const receivedAt = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null;
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const text = plainTextWithMarkup(parsed.text ?? '') || (html ? htmlToText(html) : '');
  return {
    base: { fromDomain: domain, subject: subject.slice(0, 200), receivedAt }, domain, subject,
    req: { app: 'resell', ref: triageRef(id), system: TRIAGE_SYSTEM, text: redactForTriage({ fromDomain: domain, subject, text }), json: true, max_tokens: 600 },
  };
}

// A row that says why the message got no answer, so it shows in the list and the buttons work. Never throws.
async function recordFailed(id: string, error: string): Promise<void> {
  try {
    await prisma.inboxTriage.upsert({
      where: { messageId: id },
      create: { messageId: id, fromDomain: '', subject: '', status: 'failed', error },
      update: { status: 'failed', error },
    });
  } catch (e) {
    console.error(`[inbox-triage] ${triageRef(id)} could not record failure:`, String(e).slice(0, 160));
  }
}

export async function runInboxTriage(cf: CloudflareCreds, cache: ParsedCache, opts: Opts = { maxSubmit: 10, maxPoll: 20, budgetMs: 60_000 }): Promise<void> {
  if ((await getSetting(null, TRIAGE_KEY))?.value !== 'on') return;
  const env = promptJobsEnv();
  if (!env) return;
  const deadline = Date.now() + opts.budgetMs;
  const spent = () => Date.now() >= deadline;

  // Submit: rows a person asked to retry first, then messages not seen before. Each message counts once against the cap, success or not.
  const unknown = [...cache].filter(([, v]) => v === null).map(([id]) => id);
  const retry = await prisma.inboxTriage.findMany({ where: { status: 'retry' }, orderBy: { createdAt: 'asc' }, take: opts.maxSubmit, select: { messageId: true } });
  const seen = new Set(unknown.length ? (await prisma.inboxTriage.findMany({ where: { messageId: { in: unknown } }, select: { messageId: true } })).map(r => r.messageId) : []);
  const work = [...retry.map(r => r.messageId), ...unknown.filter(id => !seen.has(id))];
  if (work.length) {
    const rules = await prisma.inboxIgnoreRule.findMany();
    let attempts = 0;
    for (const id of work) {
      if (spent() || attempts++ >= opts.maxSubmit) break;
      let prepared: Prepared | null;
      try {
        prepared = await prepare(cf, id);
      } catch (e) {
        console.error(`[inbox-triage] ${triageRef(id)} unreadable:`, String(e).slice(0, 160));
        await recordFailed(id, 'unreadable');
        continue;
      }
      if (!prepared) {
        console.error(`[inbox-triage] ${triageRef(id)} not found`);
        await recordFailed(id, 'not found');
        continue;
      }
      const { base, domain, subject, req } = prepared;

      try {
        const rule = findIgnoreRule(rules, domain, subject);
        if (rule) {
          const now = new Date();
          const data = { ...base, status: 'done', error: null, recommend: 'ignore', reason: 'Matched an ignore rule', decision: 'ignored', decidedAt: now };
          await prisma.inboxTriage.upsert({ where: { messageId: id }, create: { messageId: id, ...data }, update: data });
          await prisma.inboxIgnoreRule.update({ where: { id: rule.id }, data: { hits: { increment: 1 }, lastHitAt: now } });
          rule.hits += 1;
          continue;
        }
      } catch (e) {
        console.error(`[inbox-triage] ${triageRef(id)} rule write failed:`, String(e).slice(0, 160));
        continue;
      }

      let job;
      try {
        job = await submitPromptJob(env, req);
      } catch (e) {
        const { kind, status } = submitErrorKind(e);
        console.error(`[inbox-triage] ${triageRef(id)} submit failed:`, status ?? 'error');
        if (kind === 'rejected') { await recordFailed(id, `rejected ${status}`); continue; }
        // The queue itself is down, slow, rate limiting or refusing us: every message would fail the same way. Next run.
        break;
      }
      try {
        const data = { ...base, status: 'pending', error: null, jobId: job.id };
        const row = await prisma.inboxTriage.upsert({ where: { messageId: id }, create: { messageId: id, ...data }, update: data });
        console.log(`[inbox-triage] ${row.id} submitted`);
      } catch (e) {
        console.error(`[inbox-triage] ${triageRef(id)} row write failed:`, String(e).slice(0, 160));
      }
    }
  }

  // Rows the model never answered, all at once: nothing in them is worth a request to a dead queue.
  const failStale = async () => {
    const r = await prisma.inboxTriage.updateMany({
      where: { status: 'pending', createdAt: { lt: new Date(Date.now() - GIVE_UP_MS) } },
      data: { status: 'failed', error: 'timeout' },
    });
    if (r.count) console.log(`[inbox-triage] ${r.count} timed out`);
  };

  // Poll.
  const pending = await prisma.inboxTriage.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: opts.maxPoll });
  for (const row of pending) {
    if (spent()) break;
    try {
      const fail = async (error: string) => {
        await prisma.inboxTriage.update({ where: { id: row.id }, data: { status: 'failed', error } });
        console.log(`[inbox-triage] ${row.id} failed`);
      };
      const tooOld = Date.now() - row.createdAt.getTime() > GIVE_UP_MS;
      if (!row.jobId) { await fail('no job'); continue; }
      let job;
      try {
        job = await getPromptJob(env, row.jobId);
      } catch (e) {
        const status = (e as { status?: unknown } | null | undefined)?.status;
        if (status === 404) { await fail('job lost'); continue; }
        // Anything else means the queue is down or slow: each row would wait for the timeout too. Stop for this run.
        if (tooOld) await fail('timeout');
        break;
      }
      if (job.status === 'done') {
        const r = parseTriageResult(job.result);
        if (!r) { await fail('bad answer'); continue; }
        await prisma.inboxTriage.update({
          where: { id: row.id },
          data: {
            status: 'done', error: null, category: r.category, recommend: r.recommend, reason: r.reason, ingestKind: r.ingestKind,
            fields: JSON.stringify(r.fields), ruleFromDomain: r.ignoreRule?.fromDomain ?? null, ruleSubject: r.ignoreRule?.subjectContains ?? null,
          },
        });
        console.log(`[inbox-triage] ${row.id} done`);
      } else if (job.status === 'failed') {
        await fail((job.error ?? 'failed').slice(0, 100));
      } else if (tooOld) {
        await fail('timeout');
      }
    } catch (e) {
      console.error('[inbox-triage] poll failed:', String(e).slice(0, 160));
    }
  }
  // Also when the loop stopped early, so rows the queue never answered do not wait forever.
  await failStale().catch(e => console.error('[inbox-triage] stale sweep failed:', String(e).slice(0, 160)));
}
