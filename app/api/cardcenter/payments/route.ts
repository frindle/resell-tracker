import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';

const BASE_URL = 'https://cardcenter.cc';

export async function GET(req: Request) {
  const userId = await getSessionUserId();

  const [emailSetting, passwordSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
    prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
  ]);
  if (!emailSetting?.value || !passwordSetting?.value) {
    return Response.json({ error: 'CardCenter not configured' }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') ?? '';

  try {
    const token = await getCcToken(emailSetting.value, passwordSetting.value);

    const params = new URLSearchParams();
    if (status) params.set('status', status);

    let allItems: unknown[] = [];
    let pageToken = '';

    do {
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`${BASE_URL}/Api/Payments?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return Response.json({ error: `CardCenter error ${res.status}` }, { status: 502 });
      const data = await res.json() as { items?: unknown[]; nextPageToken?: string };
      allItems = allItems.concat(data.items ?? []);
      pageToken = data.nextPageToken ?? '';
    } while (pageToken);

    return Response.json({ items: allItems });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
