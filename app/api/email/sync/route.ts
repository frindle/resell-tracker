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
    const emails = await fetchOrderEmails(creds);
    return Response.json(emails);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
