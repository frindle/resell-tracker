import { getSessionUserId } from '@/lib/auth';
import { makeEgiftDeps } from '@/lib/egiftLinkDeps';
import { handleGet, handlePut, handleDelete } from '@/lib/egiftLinkApi';

// Thin wiring: all request logic (and its tests) lives in lib/egiftLinkApi.ts.
const deps = makeEgiftDeps(getSessionUserId);

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return handleGet(deps, req, (await params).id);
}

export async function PUT(req: Request, { params }: Ctx) {
  return handlePut(deps, req, (await params).id);
}

export async function DELETE(req: Request, { params }: Ctx) {
  return handleDelete(deps, req, (await params).id);
}
