import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptJobsEnv, submitPromptJob, getPromptJob } from './promptJobs.ts';

const env = { url: 'http://queue.example.com:8080/', token: 'tok-123' };
const req = { app: 'resell', ref: 'triage:abc', system: 'Be brief.', text: 'SECRET BODY', json: true as const, max_tokens: 600 };

type Call = { url: string; init: RequestInit };
function stub(status: number, body: unknown): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

test('submit posts the job with the bearer token and returns the id on 202', async () => {
  const { fetchFn, calls } = stub(202, { id: 'job-1', status: 'pending' });
  assert.deepEqual(await submitPromptJob(env, req, fetchFn), { id: 'job-1', status: 'pending' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://queue.example.com:8080/api/prompt-jobs');
  assert.equal(calls[0].init.method, 'POST');
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer tok-123');
  assert.equal(h['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), req);
});

test('submitting a live ref again answers 200 with the same id', async () => {
  const { fetchFn } = stub(200, { id: 'job-1', status: 'running' });
  assert.deepEqual(await submitPromptJob(env, req, fetchFn), { id: 'job-1', status: 'running' });
});

test('get reads the job and maps its fields', async () => {
  const { fetchFn, calls } = stub(200, { id: 'job-1', status: 'done', lane: 'fast', model: 'local-1', result: { category: 'other' }, error: null });
  const job = await getPromptJob(env, 'job-1', fetchFn);
  assert.equal(calls[0].url, 'http://queue.example.com:8080/api/prompt-jobs/job-1');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer tok-123');
  assert.deepEqual(job, { id: 'job-1', status: 'done', lane: 'fast', model: 'local-1', result: { category: 'other' }, error: null });
});

test('get maps a failed job and an unknown status', async () => {
  const failed = await getPromptJob(env, 'j', stub(200, { id: 'j', status: 'failed', error: 'model_error' }).fetchFn);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'model_error');
  assert.equal(failed.result, null);
  assert.equal((await getPromptJob(env, 'j', stub(200, { id: 'j', status: 'weird' }).fetchFn)).status, 'pending');
});

test('a non-OK status throws with the status and never the text or body', async () => {
  const { fetchFn } = stub(500, 'echo SECRET BODY and the model result');
  await assert.rejects(submitPromptJob(env, req, fetchFn), (e: Error & { status?: number }) => {
    assert.equal(e.status, 500);
    assert.match(e.message, /500/);
    assert.ok(!e.message.includes('SECRET'));
    assert.ok(!e.message.includes('result'));
    return true;
  });
  await assert.rejects(getPromptJob(env, 'job-1', stub(404, 'nope SECRET').fetchFn), (e: Error & { status?: number }) => e.status === 404 && !e.message.includes('SECRET'));
  await assert.rejects(submitPromptJob(env, req, stub(503, '').fetchFn), /503/);
});

test('promptJobsEnv is null unless both env vars are set', () => {
  const saved = { url: process.env.DIGEST_QUEUE_URL, token: process.env.QUEUE_PROMPT_TOKEN };
  try {
    delete process.env.DIGEST_QUEUE_URL;
    delete process.env.QUEUE_PROMPT_TOKEN;
    assert.equal(promptJobsEnv(), null);
    process.env.DIGEST_QUEUE_URL = 'http://queue.example.com';
    assert.equal(promptJobsEnv(), null);
    delete process.env.DIGEST_QUEUE_URL;
    process.env.QUEUE_PROMPT_TOKEN = 'tok';
    assert.equal(promptJobsEnv(), null);
    process.env.DIGEST_QUEUE_URL = 'http://queue.example.com';
    assert.deepEqual(promptJobsEnv(), { url: 'http://queue.example.com', token: 'tok' });
  } finally {
    if (saved.url === undefined) delete process.env.DIGEST_QUEUE_URL; else process.env.DIGEST_QUEUE_URL = saved.url;
    if (saved.token === undefined) delete process.env.QUEUE_PROMPT_TOKEN; else process.env.QUEUE_PROMPT_TOKEN = saved.token;
  }
});
