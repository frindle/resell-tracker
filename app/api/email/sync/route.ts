import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { fetchOrderEmails } from '@/lib/emailSync';
import { fetchCloudflareOrderEmails } from '@/lib/emailCloudflare';
import { orderInboxCreds } from '@/lib/emailCreds';
import { routeEmail } from '@/lib/emailParse';
import { ingestEgiftEmails, sweepEgiftScrapes } from '@/lib/egiftIngestDb';
import { NextRequest } from 'next/server';
import { matchShippingRule } from '@/lib/shippingRuleMatch';
import { MERCHANTS_KEY, parseLearnedMerchants, resolveMerchant } from '@/lib/merchants';

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
    const [emails, shippingRules, senderRules, userCount, merchants] = await Promise.all([
      inbox.kind === 'cloudflare'
        ? fetchCloudflareOrderEmails(inbox.cf, since)
        : fetchOrderEmails(inbox.creds, since, { shared: inbox.shared }),
      prisma.shippingRule.findMany({ where: { userId: uid }, select: { pattern: true, buyerId: true } }),
      inbox.shared ? prisma.senderRule.findMany({ select: { userId: true, pattern: true } }) : Promise.resolve([]),
      inbox.shared ? prisma.user.count() : Promise.resolve(1),
      getSetting(null, MERCHANTS_KEY),
    ]);
    // Costco eGift delivery emails: save the link and queue the card scrape for this user's own orders.
    // The delivery link rides on a non-enumerable property, so it is not in the JSON below.
    // Links still waiting for a recipient email ride in a header (the body is the email array).
    let egiftWaiting = 0;
    if (uid != null) {
      await ingestEgiftEmails(emails, { userId: uid });
      egiftWaiting = (await sweepEgiftScrapes({ userId: uid })).waiting;
    }
    const learned = parseLearnedMerchants(merchants?.value);

    const onlyUserId = userCount === 1 ? uid : null;
    const out = [];
    for (const email of emails) {
      let routing: 'mine' | 'unassigned' | 'ambiguous' = 'mine';
      if (inbox.shared) {
        const r = routeEmail(senderRules, email, { inboxAddress: inbox.kind === 'gmail' ? inbox.creds.address : undefined, onlyUserId });
        if (r.userId != null && r.userId !== uid) continue;
        routing = r.userId != null ? 'mine' : r.via === 'ambiguous' ? 'ambiguous' : 'unassigned';
      }
      const match = matchShippingRule(email.shippingAddress, shippingRules);
      out.push({ ...email, routing, matchedBuyerId: match?.buyerId ?? null, merchant: resolveMerchant(email.platform, email.from, learned) });
    }

    return Response.json(out, egiftWaiting ? { headers: { 'X-Egift-Waiting': String(egiftWaiting) } } : undefined);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
