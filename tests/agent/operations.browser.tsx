import React from "react";
import { createRoot } from "react-dom/client";
import { OperationReview } from "../../src/components/assistant/operation-review";
createRoot(document.getElementById("root")!).render(<OperationReview intent={location.search.includes("confirmation") ? { kind: "customer_order_confirm", params: { sale_id: "10000000-0000-4000-8000-000000000077" } } : location.search.includes("reserve") ? { kind: "customer_order_reserve", params: { sale_id: "10000000-0000-4000-8000-000000000077" } } : location.search.includes("draft") ? { kind: "customer_order_create", params: {
 customer_id: "10000000-0000-4000-8000-000000000001", warehouse_id: "10000000-0000-4000-8000-000000000002",
 currency_id: "10000000-0000-4000-8000-000000000003", contract_id: null, planned_shipment_date: "2099-01-20",
 items: [{ product_id: "10000000-0000-4000-8000-000000000004", quantity: "2", uom: "box", unit_price: "100.1250" }],
} } : location.search.includes("order") ? { kind: "customer_order_fulfillment", params: { sale_id: "10000000-0000-4000-8000-000000000077" } } : { kind: "inventory_transfer", params: {
 product_id: "10000000-0000-4000-8000-000000000001", from_warehouse_id: "10000000-0000-4000-8000-000000000002",
 to_warehouse_id: "10000000-0000-4000-8000-000000000003", quantity: "2", uom: "box",
} }} />);
