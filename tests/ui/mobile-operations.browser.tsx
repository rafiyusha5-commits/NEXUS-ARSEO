import React from "react";
import { createRoot } from "react-dom/client";
import { MobileCountView } from "../../src/components/mobile-count";
import { MoveView } from "../../src/components/mobile-move";
import { PickOrderView } from "../../src/components/mobile-pick";
import { MobileReceiveForm } from "../../src/components/mobile-receive-form";
import { ScanResultView } from "../../src/components/scan-result";
import { ExpectedBatchesView } from "../../src/components/shipments/expected-batches-view";
import type { ExpectedBatch, ShipmentExpected } from "../../src/lib/shipments/expected-batches";
import type { CountSheet } from "../../src/lib/inventory/counts";
import { matchPick, type PickList } from "../../src/lib/scan/operations";
import type { ScanResult, StockRow } from "../../src/lib/scan/lookup";

// Synthetic data shaped as order_pick_list, scan_lookup, inventory_count_sheet and the receiving page return them.
declare global { interface Window { submitted: Array<Array<[string, string]>> } }
window.submitted = [];
const record = (data: FormData) => { window.submitted.push([...data.entries()].map(([key, value]) => [key, String(value)])); };

const line = (n: number, location: string, sku: string, product: string, batch: string, expiry: string, quantity: string, picked: string) => ({
  reservation_id: `r${n}`, sku, product, product_id: `p${n}`, batch_id: `b${n}`, batch, expiry_date: expiry, location_id: `l${n}`, location,
  uom: "piece", quantity, picked });
const list: PickList = { sale_id: "s1", sale_number: "ЗК-2026-0412", status: "confirmed", customer: "ТОО «Синтетический ритейл»", can_replace: false, lines: [
  line(1, "A-01-03", "SCAN-1", "Шоколад молочный 90 г", "LOT-77", "2027-03-30", "24", "24"),
  line(2, "A-02-01", "SCAN-2", "Вафли ореховые 150 г", "W-2611", "2027-06-15", "36", "0"),
  line(3, "B-04-02", "SCAN-3", "Печенье овсяное 300 г", "OAT-9", "2027-01-20", "12", "0")] };
const stock = (batch: string, batchId: string, productId: string, location: string): StockRow => ({ balance_id: `${batch}-${location}`, warehouse_id: "w", warehouse: "ALM",
  location_id: location, location, product_id: productId, sku: "SCAN-2", product: "Вафли ореховые 150 г", batch_id: batchId, batch, expiry_date: "2027-06-15",
  batch_status: "available", uom: "piece", on_hand: "60", reserved: "36", free: "24", unit_cost: null, cost_currency: null, cost_uom: null });
const batchScan = (id: string, batch: string, productId: string): ScanResult => ({ kind: "batch", code: "NX-7KQ2M9TA",
  batch: { id, batch, expiry_date: "2027-06-15", status: "available", product_id: productId, sku: "SCAN-2", product: "Вафли ореховые 150 г" }, stock: [] });
const allPicked: PickList = { ...list, lines: list.lines.map(item => ({ ...item, picked: item.quantity })) };

const sheet: CountSheet = {
  id: "c1", number: "ИНВ-000014", status: "counting", kind: "partial", blind: true, note: null, warehouse_id: "w", warehouse: "ALM", responsible: "Синтетический кладовщик",
  created_at: "2026-11-28T04:00:00Z", started_at: "2026-11-28T05:00:00Z", review_at: null, posted_at: null, cancelled_at: null, cancellation_reason: null,
  tolerance_pieces: "0", adjustment_document_id: null, adjustment_document: null, round: 1, can_manage: false, can_record: true, can_approve: false,
  scope: [], locations: [{ id: "l1", code: "A-01-03", zone: "storage" }, { id: "l2", code: "A-02-01", zone: "storage" }], no_location: false,
  entries: [{ id: "e1", round: 1, location_id: "l1", location: "A-01-03", product_id: "p2", sku: "SCAN-2", product: "Вафли ореховые 150 г", batch_id: "b2",
    batch: "W-2611", expiry_date: "2027-06-15", uom: "box", quantity: "3", note: null, counted_by: "Кладовщик", counted_at: "2026-11-28T05:10:00Z",
    supersedes_entry_id: null, superseded: false }], recount: null, book: null };

const expectedBatch = (id: string, batch: string, extra: Partial<ExpectedBatch> = {}): ExpectedBatch => ({ id, batch, expiry_date: "2027-11-30", manufacture_date: null,
  quantity: "1200", packages: 6, source: "packing_list", source_note: "Packing list 7781", state: "expected", note: null, batch_id: null, label_code: null, printed: false, ...extra });
const shipmentBatches: ShipmentExpected = { shipment_id: "sh", shipment_number: "NAR-2026-0118", status: "in_transit", can_manage: true, orphans: [], items: [
  { item_id: "i1", product_id: "p1", sku: "NUT-13", product: "Фундук ядро 13–15", uom: "piece", quantity: "2000", transport_id: "t2", transport_no: 2, transport_status: "in_transit",
    received: false, batches: [expectedBatch("e1", "2611-01-07", { label_code: "NX-4WQ7M2KD", printed: true }), expectedBatch("e2", "2611-01-08", { quantity: "800", packages: 4 }),
      expectedBatch("e3", "2611-01-99", { state: "cancelled", note: "Нет в упаковочном листе", source: "manual", packages: null })] },
  { item_id: "i2", product_id: "p2", sku: "ALM-27", product: "Миндаль 27–30", uom: "piece", quantity: "500", transport_id: "t1", transport_no: 1, transport_status: "arrived",
    received: true, batches: [expectedBatch("e4", "A-5501", { state: "received", batch_id: "b4", label_code: "NX-7T02EZ1X", printed: true, quantity: "300" }),
      expectedBatch("e5", "A-5502", { state: "mismatch", note: "Срок по упаковочному листу 30.11.2027, при приёмке 15.12.2027: наклейка не привязана", label_code: "NX-3HD8WQ1C", printed: true })] }] };

const view = new URLSearchParams(location.search).get("view") ?? "pick";
function Body() {
  if (view === "pick") return <PickOrderView list={list} match={matchPick(list, batchScan("b2", "W-2611", "p2"))} code="NX-7KQ2M9TA" pickAction={record} shipAction={record}/>;
  if (view === "pick-foreign") return <PickOrderView list={list} match={matchPick(list, batchScan("b9", "W-2507", "p2"))} code="NX-3HD8WQ1C" pickAction={record} shipAction={record}/>;
  if (view === "pick-batch") return <PickOrderView list={list} match={matchPick(list, { kind: "product", code: "04601234567800", products: [{ product_id: "p2",
    sku: "SCAN-2", product: "Вафли ореховые 150 г", identifier_type: "gtin", uom: "piece", pieces: null, batch_found: null, stock: [stock("W-2611", "b2", "p2", "A-02-01")] }] })}
    code="04601234567800" pickAction={record} shipAction={record}/>;
  if (view === "pick-done") return <PickOrderView list={allPicked} match={null} message={{ type: "success", text: "Отбор записан." }} pickAction={record} shipAction={record}/>;
  if (view === "move") return <MoveView code="NX-5TR4K2PZ" balance={{ id: "bal", warehouse_id: "w", warehouse: "ALM", location_id: "l2", location: "A-02-01", sku: "SCAN-2",
    product: "Вафли ореховые 150 г", batch: "W-2611", expiry_date: "2027-06-15", batch_status: "available", uom: "piece", on_hand: 60, reserved: 36 }}
    locations={[{ id: "l1", code: "A-01-03", zone: "storage" }, { id: "l2", code: "A-02-01", zone: "storage" }, { id: "l4", code: "D-01-01", zone: "dispatch" }]}
    destination={{ id: "l4", code: "D-01-01", zone: "dispatch" }} moveAction={record}/>;
  if (view === "count") return <MobileCountView sheet={sheet} place={{ id: "l1", code: "A-01-03" }} code="14601234567890" recordAction={record}
    products={[{ id: "p1", sku: "SCAN-1", product: "Шоколад молочный 90 г", uoms: ["piece", "box"], batch_id: "b1", uom: "box",
      batches: [{ id: "b1", batch: "LOT-77", expiry_date: "2027-03-30" }, { id: "b8", batch: "LOT-88", expiry_date: "2027-09-25" }] }]}/>;
  if (view === "shipment-batches") return <><h1>NAR-2026-0118</h1><ExpectedBatchesView shipment={shipmentBatches} addAction={record} cancelAction={record}
    lots={[{ lot: "2611-01-09", description: "HAZELNUT KERNELS 13-15", quantity: 400, expiry: "2027-12-31", packages: 2, documents: ["Packing list 7781", "Certificate 2611"] }]}/></>;
  if (view === "scan-expected") return <><h1 className="mobile-title">Поиск по коду</h1><ScanResultView today="2026-11-28" params={{ via: "scanner" }} bindAction={record}
    result={{ kind: "expected", code: "NX-4WQ7M2KD", expected: { id: "e", state: "mismatch", batch: "2611-01-07", expiry_date: "2027-11-30", quantity: "1200",
      note: "Срок по упаковочному листу 30.11.2027, при приёмке 15.12.2027: наклейка не привязана", product_id: "p", sku: "NUT-13", product: "Фундук ядро 13–15",
      shipment: "NAR-2026-0118", transport_no: 2 } }}/></>;
  if (view === "receive-expected") return <><h1 className="mobile-title">NAR-2026-0118 · машина №2</h1>
    <MobileReceiveForm shipmentId="sh" transportId="tr" performer="Синтетический кладовщик" action={record} locations={[{ id: "l5", code: "R-01", zone: "receiving" }]}
      items={[{ item_id: "i1", title: "NUT-13 · Фундук ядро 13–15", expected: 2000, unit: "кг", codes: [], batches: [
        { expected: "1200", batch: "2611-01-07", expiry: "2027-11-30", manufactured: "", code: "NX-4WQ7M2KD" },
        { expected: "800", batch: "2611-01-08", expiry: "", manufactured: "", code: "NX-9HT3B6RE" }] }]}/></>;
  return <><h1 className="mobile-title">ПСТ-2026-118 · машина №2</h1>
    <MobileReceiveForm shipmentId="sh" transportId="tr" performer="Синтетический кладовщик" action={record}
      locations={[{ id: "l1", code: "A-01-03", zone: "storage" }, { id: "l5", code: "R-01", zone: "receiving" }]}
      items={[{ item_id: "i1", title: "SCAN-1 · Шоколад молочный 90 г", expected: 240, unit: "шт.", codes: ["4601234567893", "04601234567800"] },
              { item_id: "i2", title: "SCAN-2 · Вафли ореховые 150 г", expected: 120, unit: "шт.", codes: ["4607000000014"] }]}/></>;
}
createRoot(document.getElementById("root")!).render(view === "shipment-batches"
  ? <main className="app-shell"><aside className="sidebar"><strong>Nexus</strong></aside><section className="workspace admin-workspace"><Body/><pre id="pushes"></pre></section></main>
  : <div className="mobile-shell"><header className="mobile-header"><a className="mobile-brand" href="/m">Nexus · Склад</a></header>
  <main className="mobile-main"><Body/><pre id="pushes" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}></pre></main></div>);
