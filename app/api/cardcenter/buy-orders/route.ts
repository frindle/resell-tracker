import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';

const BASE_URL = 'https://cardcenter.cc';

export async function GET() {
  try {
    const userId = await getSessionUserId();

    const [emailSetting, passwordSetting] = await Promise.all([
      prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
      prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
    }

    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    const res = await fetch(`${BASE_URL}/Api/BuyOrders/v2?organization=&brand=&date=&pageSize=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return Response.json({ error: `CardCenter error ${res.status}` }, { status: 502 });

    const data = await res.json() as {
      items: Array<{
        id: number;
        brand: { name: string; slug: string; image: { id: string } };
        value: number;
        rate: number;
        paymentTerms: number;
        maximumPaymentTerms: number;
        flexType: string;
        availableCap: number;
        unfulfilledPerSellerCap: number;
      }>;
    };

    const items = (data.items ?? []).filter(i => i.availableCap > 0);

    const brandMap = new Map<string, { name: string; rates: typeof items }>();
    for (const item of items) {
      const name = item.brand.name;
      if (!brandMap.has(name)) brandMap.set(name, { name, rates: [] });
      brandMap.get(name)!.rates.push(item);
    }

    const brands = Array.from(brandMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const brand of brands) {
      brand.rates.sort((a, b) => a.value - b.value || b.rate - a.rate);
    }

    return Response.json({ brands });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
