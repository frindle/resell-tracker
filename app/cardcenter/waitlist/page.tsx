import { redirect } from 'next/navigation';

// The waitlist moved into the Pending page (cards grouped by brand, bulk waitlist).
export default function WaitlistRedirect() {
  redirect('/cardcenter/pending');
}
