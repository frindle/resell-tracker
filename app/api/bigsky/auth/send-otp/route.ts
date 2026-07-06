import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { getSetting, upsertSetting } from '@/lib/db';
import { sendBigSkyOtp } from '@/lib/bigsky';

// Kick off BigSky email-OTP login. Body: { email? } — falls back to the
// stored bigsky_email setting. Stores the email so verify-otp can reuse it.
export async function POST(req: NextRequest) {
  try {
    const uid = await getSessionUserId();
    const body = await req.json().catch(() => ({})) as { email?: string };
    const stored = await getSetting(uid ?? null, 'bigsky_email');
    const email = (body.email || stored?.value || '').trim();
    if (!email) {
      return Response.json({ error: 'Email required' }, { status: 400 });
    }
    await sendBigSkyOtp(email);
    await upsertSetting(uid ?? null, 'bigsky_email', email);
    return Response.json({ ok: true, email });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
