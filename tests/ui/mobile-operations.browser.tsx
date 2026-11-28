import React from "react";
import { createRoot } from "react-dom/client";
import { MobileCountView } from "../../src/components/mobile-count";
import { MoveView } from "../../src/components/mobile-move";
import { PickOrderView } from "../../src/components/mobile-pick";
import { MobileReceiveForm } from "../../src/components/mobile-receive-form";
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
  return <><h1 className="mobile-title">ПСТ-2026-118 · машина №2</h1>
    <MobileReceiveForm shipmentId="sh" transportId="tr" performer="Синтетический кладовщик" action={record}
      locations={[{ id: "l1", code: "A-01-03", zone: "storage" }, { id: "l5", code: "R-01", zone: "receiving" }]}
      items={[{ item_id: "i1", title: "SCAN-1 · Шоколад молочный 90 г", expected: 240, unit: "шт.", codes: ["4601234567893", "04601234567800"] },
              { item_id: "i2", title: "SCAN-2 · Вафли ореховые 150 г", expected: 120, unit: "шт.", codes: ["4607000000014"] }]}/></>;
}
createRoot(document.getElementById("root")!).render(<div className="mobile-shell"><header className="mobile-header"><a className="mobile-brand" href="/m">Nexus · Склад</a></header>
  <main className="mobile-main"><Body/><pre id="pushes" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}></pre></main></div>);
