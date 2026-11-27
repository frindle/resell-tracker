import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';
import { COSTCO_REWARD_RATE_KEY } from '@/lib/costcoReward';
import { sweepEgiftScrapes } from '@/lib/egiftIngestDb';
import { EGIFT_DEFAULT_EMAIL_KEY, EGIFT_DEFAULT_EMAIL_MASKED_KEY, normalizeEgiftEmail, maskEgiftEmail } from '@/lib/egiftEmail';
import { withKeyedLock } from '@/lib/keyedLock';
import { syncAllMemberRewards } from '@/lib/memberRewardSync';
import { scheduleBooksReconcile } from '@/lib/books/service';

// Force per-request evaluation -- GET route handlers in this Next.js
// version can otherwise get statically evaluated once (e.g. at build
// time, before any real request/session exists) and serve that same
// cached response forever after. Confirmed live on a sibling route
// (api/sidecar/vnc-passwords) tonight: identical response regardless of
// the actual request. This route resolves per-user via session cookie /
// X-Extension-User-Id header, so a cached response would leak one user's
// settings to every caller.
export const dynamic = 'force-dynamic';

// Same X-Extension-User-Id fallback /api/import already uses for
// unattended callers with no session cookie (the browser extension, and
// now the headless sidecar) — lets it read/write its own status/last-sync
// Setting rows (e.g. walmart_session_status, walmart_sidecar_last_sync)
// without a login flow.
async function resolveUserId(req: NextRequest | Request): Promise<number | null> {
  const sessionUid = await getSessionUserId();
  return resolveExtensionUserId(req, sessionUid);
}

export async function GET(req: NextRequest) {
  try {
  const uid = await resolveUserId(req);
  const rows = await prisma.setting.findMany({ where: { userId: uid } });
  const settings: Record<string, string> = {};
  // The upload Cloudflare token only leaves the server inside a setup code.
  rows.forEach(r => { if (!r.key.startsWith('cf_upload_') && r.key !== 'email_inbox_app_password' && r.key !== 'email_cf_token' && r.key !== EGIFT_DEFAULT_EMAIL_KEY) settings[r.key] = r.value; });
  // The default eGift address never leaves in full: only a mask for display.
  const egift = await getSetting(uid, EGIFT_DEFAULT_EMAIL_KEY);
  const egiftEmail = normalizeEgiftEmail(egift?.value);
  if (egiftEmail) settings[EGIFT_DEFAULT_EMAIL_MASKED_KEY] = maskEgiftEmail(egiftEmail);
  return Response.json(settings);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const uid = await resolveUserId(req);
  const body: Record<string, string> = await req.json();
  // The default eGift address is validated and stored encrypted (upsertSetting
  // does that for sensitive keys); an empty value clears it. The mask is display-only.
  const { [EGIFT_DEFAULT_EMAIL_KEY]: egiftRaw, [EGIFT_DEFAULT_EMAIL_MASKED_KEY]: _mask, ...rest } = body;
  if (egiftRaw !== undefined) {
    // Only an empty string clears; a number, null or object is a bad request.
    if (typeof egiftRaw !== 'string') return Response.json({ error: 'Not a valid email address' }, { status: 400 });
    const raw = egiftRaw.trim();
    const email = normalizeEgiftEmail(raw);
    if (raw !== '' && !email) return Response.json({ error: 'Not a valid email address' }, { status: 400 });
    await withKeyedLock(`setting:${uid ?? 'none'}:${EGIFT_DEFAULT_EMAIL_KEY}`, async () => {
      if (email) await upsertSetting(uid, EGIFT_DEFAULT_EMAIL_KEY, email);
      else await prisma.setting.deleteMany({ where: { userId: uid, key: EGIFT_DEFAULT_EMAIL_KEY } });
    });
    // A default address now exists: queue the scrape for orders that were waiting for one.
    if (email && uid != null) await sweepEgiftScrapes({ userId: uid });
  }
  await Promise.all(
    Object.entries(rest).map(([key, value]) => upsertSetting(uid, key, value))
  );
  if ('vnc_password' in rest) pushVncPasswordRefresh();
  // A new Costco reward rate re-figures the reward on every Costco order the user has not typed one on.
  if (COSTCO_REWARD_RATE_KEY in rest) {
    await syncAllMemberRewards(uid);
    scheduleBooksReconcile(uid);
  }
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Best-effort push so a new password takes effect on the sidecar's live
// x11vnc session immediately, instead of waiting on its own fallback poll
// (see sidecar/src/poll.js). Never let a push failure fail the settings
// save itself -- the fallback loop covers that case.
function pushVncPasswordRefresh() {
  // No address in code: compose sets SIDECAR_PUBLIC_IP. Without one, the sidecar's poll covers it.
  const ip = process.env.SIDECAR_PUBLIC_IP || process.env.SIDECAR_IP;
  const secret = process.env.SIDECAR_SHARED_SECRET;
  if (!ip || !secret) return;
  fetch(`http://${ip}:6081/refresh-vnc-password`, {
    method: 'POST',
    headers: { 'X-Sidecar-Secret': secret },
  }).catch(e => console.error('[settings] vnc password push failed (sidecar will pick it up on its next fallback poll):', e.message));
}

// Keep getSetting exported for other routes that need it
export { getSetting };
