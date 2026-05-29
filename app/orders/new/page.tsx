import OrderForm from '@/components/OrderForm';

export default function NewOrderPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New Order</h1>
        <p className="text-gray-400 text-sm mt-1">Record a purchase and its sale details</p>
      </div>
      <OrderForm />
    </div>
  );
}
