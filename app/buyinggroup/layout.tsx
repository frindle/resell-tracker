import BuyingGroupNav from '@/components/BuyingGroupNav';

export default function BuyingGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <BuyingGroupNav />
      {children}
    </div>
  );
}
