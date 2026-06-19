import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

// GET /api/cardcenter/reservations?brand=DoorDash&value=50
// Returns open (Approved, not expired) CC reservations, optionally filtered by brand+value.
export async function GET(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const { searchParams } = new URL(req.url);
    const brand = searchParams.get('brand')?.toLowerCase();
    const value = searchParams.get('value') ? parseFloat(searchParams.get('value')!) : null;

    const [emailSetting, passwordSetting] = await Promise.all([
      prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
      prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
    }

    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    const res = await fetch(`${BASE_URL}/Api/Reservations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return Response.json({ error: `CardCenter error ${res.status}` }, { status: 502 });

    const raw = await res.json() as { items?: unknown[] } | unknown[];
    const items = (Array.isArray(raw) ? raw : (raw as { items?: unknown[] }).items ?? []) as Array<{
      id: number;
      status: string;
      expired: boolean;
      permissions: Record<string, boolean>;
      brand: { name: string };
      value: number;
      quantity: number;
      submissionDeadline: string;
      buyOrder: { id: number };
    }>;

    const open = items.filter(r => r.status === 'Approved' && !r.expired && r.permissions?.submit !== false);

    const filtered = open.filter(r => {
      if (brand) {
        const bn = r.brand?.name?.toLowerCase() ?? '';
        if (!bn.includes(brand) && !brand.includes(bn)) return false;
      }
      if (value != null && Math.abs(r.value - value) > 0.01) return false;
      return true;
    });

    return Response.json({
      reservations: filtered.map(r => ({
        id: r.id,
        brandName: r.brand?.name ?? '',
        value: r.value,
        quantity: r.quantity,
        submissionDeadline: r.submissionDeadline,
        buyOrderId: r.buyOrder?.id,
      })),
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
