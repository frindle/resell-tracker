import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { withKeyedLock } from '@/lib/keyedLock';
import { encryptSetting, decryptSetting } from '@/lib/secrets';
import { EGIFT_DEFAULT_EMAIL_KEY, normalizeEgiftEmail, maskEgiftEmail, pickEgiftEmail } from '@/lib/egiftEmail';

// The address Costco eGift cards were sent to. Personal data: the browser only
// ever gets a mask, errors never carry the address, and nothing is logged.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

type Ctx = { params: Promise<{ id: string }> };

async function resolve(rawId: string): Promise<{ orderId: number; userId: number | null } | Response> {
  const userId = (await getSessionUserId()) ?? null;
  const orderId = Number(rawId);
  if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: 'Not found' }, 404);
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return json({ error: 'Not found' }, 404);
  return { orderId, userId };
}

async function status(orderId: number, userId: number | null) {
  const [row, def] = await Promise.all([
    prisma.orderEgiftEmail.findUnique({ where: { orderId }, select: { emailEnc: true } }),
    getSetting(userId, EGIFT_DEFAULT_EMAIL_KEY),
  ]);
  const own = row ? decryptSetting(row.emailEnc) : null;
  const picked = pickEgiftEmail(own, def?.value);
  const defaultEmail = normalizeEgiftEmail(def?.value);
  return {
    hasOrderEmail: normalizeEgiftEmail(own) != null,
    masked: picked.email ? maskEgiftEmail(picked.email) : null,
    source: picked.source,
    hasDefault: defaultEmail != null,
    defaultMasked: defaultEmail ? maskEgiftEmail(defaultEmail) : null,
  };
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const r = await resolve((await params).id);
    if (r instanceof Response) return r;
    return json(await status(r.orderId, r.userId));
  } catch {
    return json({ error: 'Internal error' }, 500);
  }
}

// body: { email, saveAsDefault? }
export async function PUT(req: Request, { params }: Ctx) {
  try {
    const r = await resolve((await params).id);
    if (r instanceof Response) return r;
    const lock = await requireOrderUnlocked(r.orderId, r.userId);
    if (lock) return lock;
    const body = await req.json().catch(() => null) as { email?: unknown; saveAsDefault?: unknown } | null;
    const email = normalizeEgiftEmail(body?.email);
    if (!email) return json({ error: 'Not a valid email address' }, 400);
    const emailEnc = encryptSetting(email);
    await prisma.orderEgiftEmail.upsert({
      where: { orderId: r.orderId },
      create: { orderId: r.orderId, emailEnc },
      update: { emailEnc },
    });
    if (body?.saveAsDefault === true) {
      const userId = r.userId;
      await withKeyedLock(`setting:${userId ?? 'none'}:${EGIFT_DEFAULT_EMAIL_KEY}`, () =>
        upsertSetting(userId, EGIFT_DEFAULT_EMAIL_KEY, email),
      );
    }
    return json(await status(r.orderId, r.userId));
  } catch {
    return json({ error: 'Internal error' }, 500);
  }
}

// ?scope=default removes the user's default instead of this order's address.
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const r = await resolve((await params).id);
    if (r instanceof Response) return r;
    if (new URL(req.url).searchParams.get('scope') === 'default') {
      await prisma.setting.deleteMany({ where: { userId: r.userId, key: EGIFT_DEFAULT_EMAIL_KEY } });
    } else {
      const lock = await requireOrderUnlocked(r.orderId, r.userId);
      if (lock) return lock;
      await prisma.orderEgiftEmail.deleteMany({ where: { orderId: r.orderId } });
    }
    return json(await status(r.orderId, r.userId));
  } catch {
    return json({ error: 'Internal error' }, 500);
  }
}
