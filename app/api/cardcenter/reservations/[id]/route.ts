import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

// DELETE /api/cardcenter/reservations/[id]
// Cancels a reservation via POST /Api/Reservations/{id}/Actions/Cancel
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;

    const [emailSetting, passwordSetting] = await Promise.all([
      prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
      prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
    }

    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    const res = await fetch(`${BASE_URL}/Api/Reservations/${id}/Actions/Cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status));
      return Response.json({ error: `Cancel failed: ${text}` }, { status: 502 });
    }

    return Response.json({ cancelled: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
