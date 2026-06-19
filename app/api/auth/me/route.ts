import { getSessionUser } from '@/lib/auth';

export async function GET() {
  try {
  const user = await getSessionUser();
  if (!user) return Response.json(null, { status: 401 });
  return Response.json(user);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
