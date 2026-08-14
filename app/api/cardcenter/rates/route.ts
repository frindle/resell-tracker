import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { ccApiFetch } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

// GET /api/cardcenter/rates?brand=DoorDash&value=50
export async function GET(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const { searchParams } = new URL(req.url);
    const brand = searchParams.get('brand')?.trim().toLowerCase();
    const value = searchParams.get('value') ? parseFloat(searchParams.get('value')!) : null;

    if (!brand) return Response.json({ error: 'brand is required' }, { status: 400 });

    const [emailSetting, passwordSetting] = await Promise.all([
      getSetting(userId, 'cc_email'),
      getSetting(userId, 'cc_password'),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
    }

    const res = await ccApiFetch(userId, emailSetting.value, passwordSetting.value, '/Api/BuyOrders/v2?organization=&brand=&date=&pageSize=0');
    if (!res.ok) return Response.json({ error: `CardCenter error ${res.status}` }, { status: 502 });

    const data = await res.json() as { items: unknown[] };
    const items = (data.items ?? []) as Array<{
      id: number;
      brand: { name: string };
      value: number;
      rate: number;
      paymentTerms: number;
      maximumPaymentTerms: number;
      flexType: string;
      availableCap: number;
      autoApproveOffersUntil: string;
      unfulfilledPerSellerCap: number;
    }>;

    const matched = items.filter(item => {
      const bn = item.brand?.name?.toLowerCase() ?? '';
      const nameMatch = bn.includes(brand) || brand.includes(bn);
      const valueMatch = value == null || Math.abs(item.value - value) < 0.01;
      return nameMatch && valueMatch && item.availableCap > 0;
    });

    return Response.json({ rates: matched.map(item => ({
      id: item.id,
      brandName: item.brand.name,
      value: item.value,
      rate: item.rate,
      paymentTerms: item.paymentTerms,
      maximumPaymentTerms: item.maximumPaymentTerms,
      flexType: item.flexType,
      availableCap: item.availableCap,
      unfulfilledPerSellerCap: item.unfulfilledPerSellerCap,
      autoApproveOffersUntil: item.autoApproveOffersUntil,
    })) });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
