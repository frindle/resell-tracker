import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { getSetting, upsertSetting } from '@/lib/db';
import { verifyBigSkyOtp } from '@/lib/bigsky';

// Complete BigSky login. Body: { otp, email? }. On success the session
// cookie is captured and stored as bigsky_cookie (the same setting the
// tracking-submit path already reads), so this fully replaces the manual
// DevTools cookie paste.
export async function POST(req: NextRequest) {
  try {
    const uid = await getSessionUserId();
    const body = await req.json().catch(() => ({})) as { otp?: string; email?: string };
    const otp = (body.otp || '').trim();
    const stored = await getSetting(uid ?? null, 'bigsky_email');
    const email = (body.email || stored?.value || '').trim();
    if (!email || !otp) {
      return Response.json({ error: 'Email and OTP required' }, { status: 400 });
    }
    const cookie = await verifyBigSkyOtp(email, otp);
    await upsertSetting(uid ?? null, 'bigsky_cookie', cookie);
    await upsertSetting(uid ?? null, 'bigsky_session_updated', new Date().toISOString());
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
