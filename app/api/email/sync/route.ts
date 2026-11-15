import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { fetchOrderEmails } from '@/lib/emailSync';
import { orderInboxCreds } from '@/lib/emailCreds';
import { routeEmail } from '@/lib/emailParse';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Order emails for the signed-in user. In the shared order inbox each email
// is routed by the addresses users list under Import › Email Routing (the
// address it was sent to, or forwarded from). Emails routed to another user
// are left out; ones no rule claims, or more than one user claims, are shown
// as unassigned so someone can pick them up.
export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const inbox = await orderInboxCreds(uid);
  if (!inbox) return new Response('Order email inbox not configured', { status: 400 });

  // ?since=YYYY-MM-DD limits the IMAP search to messages on or after that date
  const sinceParam = req.nextUrl.searchParams.get('since');
  const sinceDate = sinceParam ? new Date(sinceParam) : undefined;
  const since = sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate : undefined;

  try {
    const [emails, shippingRules, senderRules, userCount] = await Promise.all([
      fetchOrderEmails(inbox.creds, since, { shared: inbox.shared }),
      prisma.shippingRule.findMany({ where: { userId: uid }, select: { pattern: true, buyerId: true } }),
      inbox.shared ? prisma.senderRule.findMany({ select: { userId: true, pattern: true } }) : Promise.resolve([]),
      inbox.shared ? prisma.user.count() : Promise.resolve(1),
    ]);

    const onlyUserId = userCount === 1 ? uid : null;
    const out = [];
    for (const email of emails) {
      let routing: 'mine' | 'unassigned' | 'ambiguous' = 'mine';
      if (inbox.shared) {
        const r = routeEmail(senderRules, email, { inboxAddress: inbox.creds.address, onlyUserId });
        if (r.userId != null && r.userId !== uid) continue;
        routing = r.userId != null ? 'mine' : r.via === 'ambiguous' ? 'ambiguous' : 'unassigned';
      }
      const addr = email.shippingAddress.toLowerCase();
      const match = addr ? shippingRules.find(r => addr.includes(r.pattern.toLowerCase())) : undefined;
      out.push({ ...email, routing, matchedBuyerId: match?.buyerId ?? null });
    }

    return Response.json(out);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
