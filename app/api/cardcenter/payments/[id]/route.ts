import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, getPaymentDetail } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;

    const [emailSetting, passwordSetting] = await Promise.all([
      prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
      prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter not configured' }, { status: 400 });
    }

    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    const payment = await getPaymentDetail(token, id);
    return Response.json(payment);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
