import CardCenterNav from '@/components/CardCenterNav';

export default function CardCenterLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <CardCenterNav />
      {children}
    </div>
  );
}
