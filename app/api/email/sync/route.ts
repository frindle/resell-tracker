import { prisma } from '@/lib/db';
import { fetchOrderEmails } from '@/lib/emailSync';

async function getCreds() {
  const [addr, pass] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'gmail_address' } }),
    prisma.setting.findUnique({ where: { key: 'gmail_app_password' } }),
  ]);
  if (!addr?.value || !pass?.value) return null;
  return { address: addr.value, appPassword: pass.value };
}

export async function GET() {
  const creds = await getCreds();
  if (!creds) return new Response('Gmail not configured', { status: 400 });

  try {
    const [emails, rules] = await Promise.all([
      fetchOrderEmails(creds),
      prisma.shippingRule.findMany({ select: { pattern: true, buyerId: true } }),
    ]);

    const enriched = emails.map(email => {
      const addr = email.shippingAddress.toLowerCase();
      const match = rules.find(r => addr.includes(r.pattern.toLowerCase()));
      return {
        ...email,
        matchedBuyerId: match?.buyerId ?? null,
      };
    });

    return Response.json(enriched);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
