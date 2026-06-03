import { version } from '@/package.json';

export async function GET() {
  try {
    const res = await fetch('https://api.github.com/repos/frindle/resell-tracker/tags', {
      headers: { 'User-Agent': 'resell-tracker' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return Response.json({ current: version, latest: null, outdated: false });
    const tags: { name: string }[] = await res.json();
    const latest = tags.find(t => /^v?\d/.test(t.name))?.name.replace(/^v/, '') ?? null;
    const outdated = latest ? latest !== version : false;
    return Response.json({ current: version, latest, outdated });
  } catch {
    return Response.json({ current: version, latest: null, outdated: false });
  }
}
