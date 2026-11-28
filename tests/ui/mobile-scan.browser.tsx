import React from "react";
import { createRoot } from "react-dom/client";
import { ScanField } from "../../src/components/scan-field";
import { ScanResultView } from "../../src/components/scan-result";
import type { ScanResult } from "../../src/lib/scan/lookup";

// Synthetic lookups shaped as scan_lookup returns them.
const stock = (batch: string, location: string, free: string, expiry: string, onHand = "30") => ({ balance_id: `${batch}-${location}`, warehouse_id: "w", warehouse: "Алматы",
  location_id: location, location, product_id: "p", sku: "SCAN-1", product: "Шоколад молочный 90 г", batch_id: batch, batch, expiry_date: expiry,
  batch_status: "available", uom: "piece", on_hand: onHand, reserved: String(Number(onHand) - Number(free)), free, unit_cost: null, cost_currency: null, cost_uom: null });
const results: Record<string, ScanResult> = {
  product: { kind: "product", code: "04601234567893", products: [{ product_id: "p", sku: "SCAN-1", product: "Шоколад молочный 90 г", identifier_type: "gtin",
    uom: "box", pieces: "12", batch_found: true, stock: [stock("LOT-77", "A-01-03", "20", "2027-03-30"), stock("LOT-88", "B-02-01", "50", "2027-09-25", "50")] }] },
  location: { kind: "location", code: "NX-7KQ2M9TA", location: { id: "l", code: "A-01-03", zone: "storage", status: "active", warehouse_id: "w", warehouse: "Алматы" },
    stock: [stock("LOT-77", "A-01-03", "20", "2027-03-30")] },
  unknown: { kind: "unknown", code: "2000000000001", can_bind: true },
};
const view = new URLSearchParams(location.search).get("view") ?? "product";
function Page() {
  return <div className="mobile-shell"><header className="mobile-header"><a className="mobile-brand" href="/m">Nexus · Склад</a></header>
    <main className="mobile-main"><h1 className="mobile-title">Поиск по коду</h1><ScanField/>
      <ScanResultView result={results[view]} today="2026-11-28" params={view === "product" ? { via: "camera", batch: "LOT-77", expiry: "2027-03-30", qty: "12" } : { via: "scanner" }}
        bindAction={() => {}}/>
      <pre id="pushes" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}></pre></main></div>;
}
createRoot(document.getElementById("root")!).render(<Page/>);
