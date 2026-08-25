# Costco `receiptsWithCounts` — captured request shapes

Captured 2026-08-25 from a live logged-in Costco session (Penn's own account, his
own browser), by arming a fetch/XHR interceptor on `ecom-api.costco.com` and
navigating Orders & Purchases → Online → an order, then Warehouse → an order.

**Why this file exists:** the browser extension declared `RECEIPT_LIST_QUERY` /
`RECEIPT_DETAIL_QUERY` but never called them, so the `documentType` /
`documentSubType` enum values appeared nowhere in the extension, this repo, or
any captured traffic. Receipts only ever arrived because a human happened to have
the in-warehouse tab open while the interceptor was live. These are the real
values, observed on the wire — not guessed.

Endpoint (both variants): `POST https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql`
Transport observed: **XHR** (not fetch) — an interceptor hooking only `fetch` misses these.

---

## Variant 1 — LIST (counts + receipt summaries for a date range)

```
query receiptsWithCounts($startDate: String!, $endDate: String!,$documentType:String!,$documentSubType:String!) {
    receiptsWithCounts(startDate: $startDate, endDate: $endDate,documentType:$documentType,documentSubType:$documentSubType) {
    inWarehouse
    gasStation
    carWash
    gasAndCarWash
    receipts{
    warehouseName receiptType  documentType transactionDateTime transactionBarcode warehouseName transactionType total
    totalItemCount
    itemArray {
      itemNumber
    }
    tenderArray {
      tenderTypeCode
      tenderDescription
      amountTender
    }
    couponArray {
      upcnumberCoupon
    }
  }
}
  }
```

Variables, verbatim:
```json
{
  "startDate": "6/01/2026",
  "endDate": "8/31/2026",
  "text": "Last 3 Months",
  "documentType": "all",
  "documentSubType": "all"
}
```

**Date format gotcha:** `6/01/2026` — single-digit MONTH, zero-padded DAY. Not
`MM/DD/YYYY`. A `%m/%d/%Y` formatter produces `06/01/2026` and is NOT what the
site sends. Match the observed shape rather than assuming.

`text` is a human label ("Last 3 Months") the UI sends alongside; it is not
declared in the query signature, so it appears to be ignored server-side. Sent
here for fidelity with the real request.

---

## Variant 2 — DETAIL (one receipt by barcode)

```
query receiptsWithCounts($barcode: String!,$documentType:String!) {
    receiptsWithCounts(barcode: $barcode,documentType:$documentType) {
      receipts{ warehouseName receiptType documentType transactionDateTime
      transactionDate companyNumber warehouseNumber operatorNumber warehouseName
      warehouseShortName registerNumber transactionNumber transactionType
      transactionBarcode total warehouseAddress1 warehouseAddress2 warehouseCity
      warehouseState warehouseCountry warehousePostalCode totalItemCount subTotal
      taxes total invoiceNumber sequenceNumber
      itemArray { itemNumber itemDescription01 frenchItemDescription1
        itemDescription02 frenchItemDescription2 itemIdentifier
        itemDepartmentNumber unit amount taxFlag merchantID entryMethod
        transDepartmentNumber fuelUnitQuantity fuelGradeCode itemUnitPriceAmount
        fuelUomCode fuelUomDescription fuelUomDescriptionFr fuelGradeDescription
        fuelGradeDescriptionFr ... }
      ... }
  }
```
(field selection abbreviated — GraphQL lets the sidecar request a narrower set;
only the signature and variables are load-bearing)

Variables, verbatim (barcode redacted — it is a real receipt identifier):
```json
{
  "barcode": "<transactionBarcode from a Variant 1 result>",
  "documentType": "warehouse"
}
```

---

## Enum values, which were the actual blocker

| field | observed values |
|---|---|
| `documentType` | `"all"` (list), `"warehouse"` (detail) |
| `documentSubType` | `"all"` (list only) |

`transactionBarcode` returned by Variant 1 is the `barcode` input to Variant 2 —
that is the join between the two calls.

## Still true after this capture

The bearer token still cannot be minted independently; it must be intercepted
off Costco's own in-page requests (`/gettoken`, MSAL `acquireTokenSilent`, and
the B2C `refresh_token` exchange all yield an `id_token` that ecom-api 401s).
This capture removes the *enum* unknown, not the *token* constraint.
