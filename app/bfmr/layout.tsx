import BfmrNav from '@/components/BfmrNav';

export default function BfmrLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <BfmrNav />
      {children}
    </div>
  );
}
