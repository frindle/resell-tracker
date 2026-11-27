import { prisma, getSetting } from '@/lib/db';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { decryptSetting } from '@/lib/secrets';
import { EGIFT_DEFAULT_EMAIL_KEY, pickEgiftEmail } from '@/lib/egiftEmail';
import { egiftSecretConfigured, normalizeCardNumber, parseEgiftCard } from '@/lib/egiftScrape';
import { withKeyedLock } from '@/lib/keyedLock';
import { scheduleBooksReconcile } from '@/lib/books/service';
import { canonicalGiftBrand } from '@/lib/giftBrand';
import { REVIEW_CODE_SOURCE } from '@/lib/giftCardReview';

// Sidecar-only (extension-secret authenticated): what the eGift scrape needs
// for one order, decrypted: the delivery link and the address the cards were
// sent to (the order's own, else the user's default). Secrets and personal
// data: never logged, never echoed in errors, never cached.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

// This route serves an access secret and personal data in the clear, so it
// never falls back to trusting the user-id header alone (the LAN-trust mode
// the other extension routes allow when no shared secret is set).
function secretMissing(): Response | null {
  return egiftSecretConfigured({ EXTENSION_SHARED_SECRET: process.env.EXTENSION_SHARED_SECRET })
    ? null
    : json({ error: 'EXTENSION_SHARED_SECRET is not configured on the server; eGift data is not served without it' }, 503);
}

export async function GET(req: Request) {
  try {
    const blocked = secretMissing();
    if (blocked) return blocked;
    const userId = resolveExtensionUserId(req, null);
    if (userId == null) return json({ error: 'unauthorized' }, 401);
    const orderId = Number(new URL(req.url).searchParams.get('orderId'));
    if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: 'Not found' }, 404);
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { egiftLink: { select: { linkEnc: true } }, egiftEmail: { select: { emailEnc: true } } },
    });
    if (!order) return json({ error: 'Not found' }, 404);
    const def = await getSetting(userId, EGIFT_DEFAULT_EMAIL_KEY);
    const { email } = pickEgiftEmail(order.egiftEmail ? decryptSetting(order.egiftEmail.emailEnc) : null, def?.value);
    const link = order.egiftLink ? decryptSetting(order.egiftLink.linkEnc) : null;
    // A saved link that will not decrypt is a fault, not "no link".
    if (order.egiftLink && !link) return json({ error: 'stored link unreadable' }, 500);
    return json({ link, email });
  } catch {
    return json({ error: 'Internal error' }, 500);
  }
}

// One scraped card: body { orderId, cardNumber, pin?, merchant?, value? }.
// Stored as an ordinary gift card on the order (same table the gift-card route
// writes). A card whose merchant/value could not be read is held for review
// (lib/giftCardReview.ts). A code already on the order is not added twice, so
// re-running a scrape is safe.
export async function POST(req: Request) {
  try {
    const blocked = secretMissing();
    if (blocked) return blocked;
    const userId = resolveExtensionUserId(req, null);
    if (userId == null) return json({ error: 'unauthorized' }, 401);
    const body = await req.json().catch(() => null) as { orderId?: unknown } | null;
    const orderId = Number(body?.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: 'Not found' }, 404);
    const card = parseEgiftCard(body);
    if (!card) return json({ error: 'a card number is required' }, 400);
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true, locked: true } });
    if (!order) return json({ error: 'Not found' }, 404);
    if (order.locked) return json({ error: 'Order is locked' }, 409);
    // One writer per order, so a retry racing the first request cannot add the card twice.
    // Compared without spaces/dashes: stored cards may have been typed either way.
    const result = await withKeyedLock(`egift-card:${orderId}`, async () => {
      const wanted = normalizeCardNumber(card.cardNumber);
      const cards = await prisma.giftCard.findMany({ where: { orderId }, select: { id: true, cardNumber: true } });
      const existing = cards.find(c => normalizeCardNumber(c.cardNumber) === wanted);
      if (existing) return { duplicateId: existing.id, created: null };
      const row = await prisma.giftCard.create({
        data: { orderId, merchant: canonicalGiftBrand(card.merchant), value: card.value, cardNumber: card.cardNumber, pin: card.pin, codeSource: card.codeSource },
      });
      return { duplicateId: null, created: row };
    });
    if (result.created === null) return json({ saved: false, duplicate: true, id: result.duplicateId });
    const created = result.created;
    scheduleBooksReconcile(userId);
    return json({ saved: true, duplicate: false, id: created.id, needsReview: card.codeSource === REVIEW_CODE_SOURCE });
  } catch {
    return json({ error: 'Internal error' }, 500);
  }
}
