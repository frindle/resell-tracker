export async function POST() {
  const res = new Response(null, { status: 204 });
  res.headers.set('Set-Cookie', 'resell_uid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  return res;
}
