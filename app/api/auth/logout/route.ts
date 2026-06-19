export async function POST() {
  try {
  const res = new Response(null, { status: 204 });
  res.headers.set('Set-Cookie', 'resell_uid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  return res;
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
