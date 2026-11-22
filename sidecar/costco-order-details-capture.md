# Costco order details: captured request shape

Captured 2026-11-17 off a signed-in session. It shows field names and value shapes only; there is no account data here.

## Request

Costco's order details page (`#/app/<app-id>/orderdetails/<orderNumber>`) sends one POST when it opens:

- **URL:** `https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql`
- **Auth:** the same bearer token and client id the order list uses. `costcoInterceptorSource` captures them.
- **Operation:** `query getOrderDetails($orderNumbers: [String])`, called with `{ "orderNumbers": ["<orderNumber>"] }`.
- **Response:** `data.getOrderDetails` comes back as one object, not an array, for one order number. `syncCostcoOrders` accepts either.

The page's own query selects about 200 fields, and `mapOrderDetails` reads the few listed below.

**Don't replay it.** On 2026-11-17, sending a cut-down copy of this query with the page's bearer token and client id got HTTP 401. The page's own request succeeds; it also carries Costco's `x-kpsdk-*` bot-check headers. So `syncCostcoOrders` opens `#/app/<app-id>/orderdetails/<orderNumber>` and reads the response through the interceptor (`window.__costcoOrderDetails`). It never sends its own request.

## Fields used

**Order:** `orderNumber : sourceOrderNumber`, `orderPlacedDate : orderedDate`, `status`, `orderTotal`.
- `orderTotal` is what was charged, after discounts. So with `merchandiseTotal` 500 and `discountAmount` 80, `orderTotal` is 420 (made-up numbers).
- `merchandiseTotal` less `discountAmount` is sent as `merchandiseSubtotal`: the base for the Costco Executive reward (lib/costcoReward.ts), before tax and shipping.
- The order-level `firstName lastName line1 … postalCode` is the **billing** address. Don't use it as the ship-to.

**`orderPayment { paymentType totalCharged cardNumber isGOMPayment … }`** is a list.
- The card: `paymentType` names the network (e.g. `Visa`), and `cardNumber` is its last four digits only.
- Coupons: `paymentType` is `Coupon`, and `cardNumber` is a 7-digit coupon id.
- Other entries (shop cards, gift of membership) are skipped by type name or by `isGOMPayment`.

**`shipToAddress : orderShipTos { firstName lastName line1 line2 line3 city state postalCode countryCode isShipToWarehouse orderLineItems { … } }`** is the ship-to.
- `postalCode` is ZIP+4.
- `isShipToWarehouse` marks a warehouse pickup, which has no delivery address.

**`orderLineItems`** are nested under each ship-to.
- Fields used: `orderStatus`, `itemDescription : sourceItemDescription`, `price : unitPrice`, `quantity : orderedTotalQuantity`.
- Each line also has `shipment { trackingNumber carrierName trackingSiteUrl shippedDate estimatedArrivalDate deliveredDate … }` and `scheduledDeliveryDate`.
