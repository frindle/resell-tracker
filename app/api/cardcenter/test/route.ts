import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { ccApiFetch } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const { email, password } = await req.json() as { email: string; password: string };
    // Any /Api/* call is enough to prove the session works — this also
    // caches it (see lib/cardcenter.ts getSession) for subsequent calls.
    const res = await ccApiFetch(userId, email, password, '/Api/Reservations');
    if (!res.ok) throw new Error(`Auth check failed (${res.status})`);
    return Response.json({ ok: true });
  } catch (e) {
    return new Response(String(e), { status: 400 });
  }
}

// GET: verify full pre-submission flow using saved credentials
export async function GET() {
  try {
    const userId = await getSessionUserId();

    const [emailSetting, passwordSetting] = await Promise.all([
      getSetting(userId, 'cc_email'),
      getSetting(userId, 'cc_password'),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
    }

    const steps: Record<string, unknown> = {};

    const resRes = await ccApiFetch(userId, emailSetting.value, passwordSetting.value, '/Api/Reservations');
    steps.auth = resRes.ok ? 'ok' : `auth call returned ${resRes.status}`;
    if (!resRes.ok) {
      steps.reservations = `HTTP ${resRes.status}`;
    } else {
      const data = await resRes.json() as { items?: Record<string, unknown>[] } | Record<string, unknown>[];
      const items = Array.isArray(data) ? data : ((data as { items?: Record<string, unknown>[] }).items ?? []);
      const byStatus = items.reduce<Record<string, number>>((acc, r) => {
        const s = String(r.status ?? 'unknown');
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {});
      steps.reservations = `ok — ${items.length} total`;
      steps.reservationsByStatus = byStatus;
      steps.reservationSample = items.slice(0, 2);
    }

    const potRes = await ccApiFetch(userId, emailSetting.value, passwordSetting.value, '/Api/PotentialSubmissions', {
      method: 'POST',
      body: JSON.stringify({ cards: [] }),
    });
    if (!potRes.ok) {
      steps.agreement = `HTTP ${potRes.status}: ${await potRes.text().catch(() => '')}`;
    } else {
      const potData = await potRes.json() as { sellerAgreement?: { agreement?: { id: string; date: string } } };
      const agreement = potData?.sellerAgreement?.agreement;
      steps.agreement = agreement?.id ? `ok — id=${agreement.id}` : 'missing sellerAgreement.agreement';
      steps.potentialSubmissionsRaw = potData;
    }

    return Response.json(steps);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
