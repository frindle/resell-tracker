export async function sendPushover(userKey: string, appToken: string, message: string, title?: string) {
  const body = new URLSearchParams({
    token: appToken,
    user: userKey,
    message,
    ...(title ? { title } : {}),
  });

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pushover error ${res.status}: ${text}`);
  }

  return res.json();
}
