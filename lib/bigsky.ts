const SUBMIT_URL = 'https://www.bigskybuyers.com/api/trpc/tracking.submitTracking?batch=1';

export async function submitTracking(cookie: string, trackingNumbers: string[]): Promise<unknown> {
  const res = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ '0': { json: { trackingNumbers } } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BigSky submit tracking ${res.status}: ${body}`);
  }
  return res.json();
}
