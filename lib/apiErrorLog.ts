import { prisma, getSetting } from '@/lib/db';

// Record a non-2xx response (or other failure) from one of the buying-group
// integrations. Safe to call from anywhere — never throws, never blocks the
// caller. The error log shows up under /api-errors and pushes a Pushover
// notification when the user has 'pushover_user_key' + 'pushover_app_token'
// settings configured.
export async function logApiError(input: {
  userId: number | null;
  group: 'BG' | 'BFMR' | 'CC' | 'Costco' | 'BigSky' | string;
  endpoint: string;
  method?: string;
  status?: number;
  body?: string;
  orderId?: number;
  context?: string;
}): Promise<void> {
  try {
    const row = await prisma.apiError.create({
      data: {
        userId: input.userId ?? null,
        group: input.group,
        endpoint: input.endpoint.slice(0, 500),
        method: input.method ?? null,
        status: input.status ?? null,
        body: input.body ? input.body.slice(0, 2000) : null,
        orderId: input.orderId ?? null,
        context: input.context ?? null,
      },
    });
    // Fire-and-forget push notification. Pushover is optional — if the
    // user hasn't configured it, this is a silent no-op.
    void sendPushover(input).catch(e => console.error('[apiErrorLog] pushover failed:', String(e).slice(0, 200)));
    void row;
  } catch (e) {
    console.error('[apiErrorLog] failed to persist:', String(e).slice(0, 200));
  }
}

async function sendPushover(input: {
  userId: number | null;
  group: string;
  endpoint: string;
  status?: number;
  context?: string;
  body?: string;
}): Promise<void> {
  const [userKey, appToken] = await Promise.all([
    getSetting(input.userId ?? null, 'pushover_user_key'),
    getSetting(input.userId ?? null, 'pushover_app_token'),
  ]);
  if (!userKey?.value || !appToken?.value) return;

  // Severity: 5xx + 401/403 are escalated to priority 1 (bypass quiet
  // hours). Everything else is priority 0 (normal). Keep the message
  // short so it fits in a phone notification.
  const status = input.status ?? 0;
  const isHigh = status >= 500 || status === 401 || status === 403;
  const title = `[${input.group}] ${status || 'error'}`;
  const messageParts = [
    input.endpoint.slice(0, 200),
    input.context ? `\n${input.context.slice(0, 100)}` : '',
    input.body ? `\n${input.body.slice(0, 200)}` : '',
  ];

  try {
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: appToken.value,
        user: userKey.value,
        title,
        message: messageParts.join(''),
        priority: isHigh ? '1' : '0',
      }).toString(),
    });
  } catch (e) {
    console.error('[apiErrorLog] pushover network error:', String(e).slice(0, 200));
  }
}
