import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import OrderForm from '@/components/OrderForm';

export const dynamic = 'force-dynamic';

export default async function EditOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
  if (!order) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Edit Order</h1>
        <p className="text-gray-400 text-sm mt-1">{order.itemDescription || `Order #${order.id}`}</p>
      </div>
      <OrderForm initialData={{
        ...order,
        orderDate: order.orderDate.toISOString(),
      }} />
    </div>
  );
}
