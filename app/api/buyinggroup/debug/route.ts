import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';

// Which request shape gets BG's receipts page 2? Since ~2026-09-24 `page: 2`
// appears to return page 1 again (115 receipts, 5 pages, but every page is the
// same 25). Reports receipt ids + counters only -- no receipt contents.
const PAGE2_VARIANTS: Record<string, unknown>[] = [
  { page: 2, page_size: 25 },
  { page: 2 },
  { page: '2', page_size: '25' },
  { page_no: 2, page_size: 25 },
  { page_number: 2, page_size: 25 },
  { pageNumber: 2, pageSize: 25 },
  { offset: 25, limit: 25 },
  { skip: 25, take: 25 },
  { page: 1, page_size: 100 },
  { pagination: { page: 2, page_size: 25 } },
];

async function probePaging(token: string) {
  const post = (body: unknown) => fetch('https://api.prod.buyinggroup.com/v1/receipt/get_receipts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json()).catch(e => ({ error: String(e) }));
  const ids = (d: { payload?: { receipts?: { receipt_id?: unknown }[] } }) => (d.payload?.receipts ?? []).map(r => String(r.receipt_id));
  const base = ids(await post({ page: 1, page_size: 25 }));
  const out = [];
  for (const body of PAGE2_VARIANTS) {
    const d = await post(body) as { status?: string; message?: string; payload?: { receipts?: { receipt_id?: unknown }[]; pages?: unknown } };
    const got = ids(d);
    out.push({ body, status: d.status, message: d.message, rows: got.length, newVsPage1: got.filter(i => !base.includes(i)).length, pages: d.payload?.pages, firstId: got[0] ?? null });
  }
  return { page1Rows: base.length, page1FirstId: base[0] ?? null, variants: out };
}

export async function GET(req: Request) {
  try {
  const userId = await getSessionUserId();
  const configured = await isBgConfigured(userId ?? null);
  if (!configured) return new Response('BuyingGroup not configured', { status: 400 });

  const token = await getBgAccessToken(userId ?? null);
  if (new URL(req.url).searchParams.get('probe') === 'paging') return Response.json(await probePaging(token));

  const [receiptsRaw, ordersRaw] = await Promise.all([
    fetch('https://api.prod.buyinggroup.com/v1/receipt/get_receipts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, page_size: 10 }),
    }).then(r => r.json()),
    fetch('https://api.prod.buyinggroup.com/v1/order/get_orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, page_size: 10 }),
    }).then(r => r.json()),
  ]);

  return Response.json({ receiptsRaw, ordersRaw });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
