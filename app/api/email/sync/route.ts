import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { fetchOrderEmails } from '@/lib/emailSync';

async function getCreds(userId: number | null) {
  const [addr, pass] = await Promise.all([
    prisma.setting.findUnique({ where: { userId_key: { userId, key: 'gmail_address' } } }),
    prisma.setting.findUnique({ where: { userId_key: { userId, key: 'gmail_app_password' } } }),
  ]);
  if (!addr?.value || !pass?.value) return null;
  return { address: addr.value, appPassword: pass.value };
}

export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const creds = await getCreds(uid);
  if (!creds) return new Response('Gmail not configured', { status: 400 });

  try {
    const [emails, shippingRules] = await Promise.all([
      fetchOrderEmails(creds),
      prisma.shippingRule.findMany({ where: { userId: uid }, select: { pattern: true, buyerId: true } }),
    ]);

    const enriched = emails.map(email => {
      const addr = email.shippingAddress.toLowerCase();
      const match = shippingRules.find(r => addr.includes(r.pattern.toLowerCase()));
      return { ...email, matchedBuyerId: match?.buyerId ?? null };
    });

    return Response.json(enriched);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
