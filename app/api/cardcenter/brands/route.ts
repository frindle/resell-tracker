import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { ccApiFetch } from '@/lib/cardcenter';

export async function GET() {
  try {
    const userId = await getSessionUserId();

    const [emailSetting, passwordSetting] = await Promise.all([
      getSetting(userId, 'cc_email'),
      getSetting(userId, 'cc_password'),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ brands: [] });
    }

    const res = await ccApiFetch(userId, emailSetting.value, passwordSetting.value, '/Api/Reservations');
    if (!res.ok) return Response.json({ brands: [] });

    const data = await res.json() as { items?: { brand: { name: string } }[] } | { brand: { name: string } }[];
    const items = Array.isArray(data) ? data : ((data as { items?: { brand: { name: string } }[] }).items ?? []);

    const brands = [...new Set(items.map(r => r.brand.name))].sort();
    return Response.json({ brands });
  } catch {
    return Response.json({ brands: [] });
  }
}
