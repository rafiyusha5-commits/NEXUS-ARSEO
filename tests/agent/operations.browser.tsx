import React from "react";
import { createRoot } from "react-dom/client";
import { OperationReview } from "../../src/components/assistant/operation-review";
createRoot(document.getElementById("root")!).render(<OperationReview intent={{ kind: "inventory_transfer", params: {
 product_id: "10000000-0000-4000-8000-000000000001", from_warehouse_id: "10000000-0000-4000-8000-000000000002",
 to_warehouse_id: "10000000-0000-4000-8000-000000000003", quantity: "2", uom: "box",
} }} />);
