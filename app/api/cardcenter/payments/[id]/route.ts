import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, ccJson, CcPayment } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

const STATUS_SEGMENT: Record<string, string> = {
  Waiting: 'Scheduled',
  Sent: 'Sent',
  Completed: 'Completed',
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const { searchParams } = new URL(req.url);

    const [emailSetting, passwordSetting] = await Promise.all([
      prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
      prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter not configured' }, { status: 400 });
    }

    const token = await getCcToken(emailSetting.value, passwordSetting.value);

    // Payment names like P1056-20260703 use the Scheduled/Sent/Completed path format
    // Numeric IDs use the standard /Api/Payments/{id} endpoint
    const nameMatch = id.match(/^P(\d+)-(\d{4})(\d{2})(\d{2})$/);
    let ccUrl: string;
    if (nameMatch) {
      const [, sellerId, year, month, day] = nameMatch;
      const status = searchParams.get('status') ?? 'Waiting';
      const buyerId = searchParams.get('buyerId') ?? '1051';
      const isoDate = `${year}-${month}-${day}`;
      ccUrl = `${BASE_URL}/Api/Payments/${STATUS_SEGMENT[status] ?? 'Scheduled'}/${buyerId}/${sellerId}/${isoDate}`;
    } else {
      ccUrl = `${BASE_URL}/Api/Payments/${encodeURIComponent(id)}`;
    }

    const res = await fetch(ccUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      return Response.json({ error: `CardCenter ${res.status}` }, { status: res.status });
    }
    const payment = await ccJson<CcPayment>(res, `Payments/${id}`);
    return Response.json(payment);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
