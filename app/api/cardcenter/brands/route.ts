import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';

const BASE_URL = 'https://cardcenter.cc';

export async function GET() {
  const userId = await getSessionUserId();

  const [emailSetting, passwordSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
    prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
  ]);
  if (!emailSetting?.value || !passwordSetting?.value) {
    return Response.json({ brands: [] });
  }

  try {
    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    const res = await fetch(`${BASE_URL}/Api/Reservations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return Response.json({ brands: [] });

    const data = await res.json() as { items?: { brand: { name: string } }[] } | { brand: { name: string } }[];
    const items = Array.isArray(data) ? data : ((data as { items?: { brand: { name: string } }[] }).items ?? []);

    const brands = [...new Set(items.map(r => r.brand.name))].sort();
    return Response.json({ brands });
  } catch {
    return Response.json({ brands: [] });
  }
}
