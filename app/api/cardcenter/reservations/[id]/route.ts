import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { ccApiFetch } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

// DELETE /api/cardcenter/reservations/[id]
// Cancels a reservation via POST /Api/Reservations/{id}/Actions/Cancel
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;

    const [emailSetting, passwordSetting] = await Promise.all([
      getSetting(userId, 'cc_email'),
      getSetting(userId, 'cc_password'),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
    }

    const res = await ccApiFetch(userId, emailSetting.value, passwordSetting.value, `/Api/Reservations/${id}/Actions/Cancel`, {
      method: 'POST',
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
