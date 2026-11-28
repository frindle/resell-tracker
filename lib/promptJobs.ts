// Client for the home lab queue's prompt-jobs API (a local model runs the prompt).
// Fetch is passed in so tests need no network. Errors carry the HTTP status only:
// the prompt text and the model's answer never go into a message or a log line.

export type PromptJobsEnv = { url: string; token: string };
type FetchFn = typeof fetch;

export type PromptJobRequest = { app: string; ref: string; system: string; text: string; json: true; max_tokens?: number };
export type PromptJobStatus = 'pending' | 'running' | 'done' | 'failed';
export type PromptJob = { id: string; status: PromptJobStatus; lane: string | null; model: string | null; result: unknown; error: string | null };

/** Null unless both the queue URL and the prompt token are set. */
export function promptJobsEnv(): PromptJobsEnv | null {
  const url = process.env.DIGEST_QUEUE_URL;
  const token = process.env.QUEUE_PROMPT_TOKEN;
  return url && token ? { url, token } : null;
}

function endpoint(env: PromptJobsEnv, path: string): string {
  return `${env.url.replace(/\/+$/, '')}${path}`;
}

function failed(what: string, status: number): Error {
  return Object.assign(new Error(`Prompt job ${what} failed: HTTP ${status}`), { status });
}

/** Queues a prompt. The same app + ref while its job is still live returns that job's id. */
export async function submitPromptJob(env: PromptJobsEnv, req: PromptJobRequest, fetchFn: FetchFn = fetch): Promise<{ id: string; status: string }> {
  const res = await fetchFn(endpoint(env, '/api/prompt-jobs'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw failed('submit', res.status);
  const body = (await res.json()) as { id?: unknown; status?: unknown };
  if (typeof body.id !== 'string' || !body.id) throw new Error('Prompt job submit failed: no id');
  return { id: body.id, status: typeof body.status === 'string' ? body.status : 'pending' };
}

export async function getPromptJob(env: PromptJobsEnv, id: string, fetchFn: FetchFn = fetch): Promise<PromptJob> {
  const res = await fetchFn(endpoint(env, `/api/prompt-jobs/${encodeURIComponent(id)}`), {
    headers: { Authorization: `Bearer ${env.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw failed('read', res.status);
  const b = (await res.json()) as Record<string, unknown>;
  const status: PromptJobStatus = b.status === 'running' || b.status === 'done' || b.status === 'failed' ? b.status : 'pending';
  return {
    id: typeof b.id === 'string' ? b.id : id,
    status,
    lane: typeof b.lane === 'string' ? b.lane : null,
    model: typeof b.model === 'string' ? b.model : null,
    result: b.result ?? null,
    error: typeof b.error === 'string' ? b.error : null,
  };
}
