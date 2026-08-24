import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Clears all locally-recorded BfmrSubmittedShipment rows for a reservation,
// resetting its remainingQty back to the full qty. For correcting a local
// record left behind by a submission that reported success but didn't
// actually land on BFMR's side (see the my_tracker_id matching fix in
// lib/bfmrWeb.ts) -- lets the UI's submit form re-open so the reservation
// can be resubmitted cleanly, instead of being stuck showing "fully
// submitted" forever.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { id } = await params;
  const reservationId = parseInt(id);
  if (isNaN(reservationId)) return Response.json({ error: 'invalid id' }, { status: 400 });

  const reservation = await prisma.bfmrReservation.findFirst({
    where: { id: reservationId, userId: uid },
  });
  if (!reservation) return Response.json({ error: 'reservation not found' }, { status: 404 });

  const { count } = await prisma.bfmrSubmittedShipment.deleteMany({
    where: { reservationId },
  });
  return Response.json({ cleared: count });
}
