import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

export async function POST(req: NextRequest) {
  const { email, password } = await req.json() as { email: string; password: string };
  try {
    await getCcToken(email, password);
    return Response.json({ ok: true });
  } catch (e) {
    return new Response(String(e), { status: 400 });
  }
}

// GET: verify full pre-submission flow using saved credentials
export async function GET() {
  const userId = await getSessionUserId();

  const [emailSetting, passwordSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
    prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
  ]);
  if (!emailSetting?.value || !passwordSetting?.value) {
    return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
  }

  const steps: Record<string, unknown> = {};

  try {
    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    steps.auth = 'ok';

    const resRes = await fetch(`${BASE_URL}/Api/Reservations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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

    const potRes = await fetch(`${BASE_URL}/Api/PotentialSubmissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  } catch (e) {
    steps.error = String(e);
  }

  return Response.json(steps);
}
