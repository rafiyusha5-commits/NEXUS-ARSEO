import assert from "node:assert/strict";
import { test } from "node:test";
import { documentActionIndex, type ActionDocument, type ActionSource } from "../src/lib/documents/action-index.ts";

const doc: ActionDocument = {
  id: "doc", status: "approved", archived_at: null, current_version: 2,
  versions: [{ id: "old", version_number: 1, is_current: false }, { id: "new", version_number: 2, is_current: true }],
  links: [{ entity_type: "shipment_transport", entity_id: "vehicle", removed_at: null }],
};
const source: ActionSource = {
  id: "result", document_id: "doc", document_version_id: "new", shipment_id: "shipment", shipment_transport_id: "vehicle",
  status: "confirmed", source_kind: "invoice", confirmed_data: { pallet_count: 0 }, extracted_data: { pallet_count: 19 },
  shipment: { shipment_number: "Example", vehicles: [{ id: "vehicle", status: "planned" }] },
};
test("actions retain separate file versions and route to the eligible result without exposing field values", () => {
  const info = documentActionIndex([doc], [source]).doc;
  assert.deepEqual(info.files, { 1: "old", 2: "new" });
  assert.deepEqual(info.reviews, [{ href: "/shipments/shipment?tab=documents#source-result-result", shipment: "Example" }]);
  assert.ok(!JSON.stringify(info).includes("pallet_count"));
});
test("document and shipment visibility, active link, current version and confirmed values bound the review", () => {
  assert.deepEqual(documentActionIndex([], [source]), {});
  for (const changed of [
    { document_version_id: "old" }, { status: "superseded" }, { confirmed_data: {} },
    { shipment: null }, { shipment: { shipment_number: "Example", vehicles: [{ id: "vehicle", status: "cancelled" }] } },
  ]) assert.deepEqual(documentActionIndex([doc], [{ ...source, ...changed }]).doc.reviews, []);
  for (const changed of [{ status: "rejected" }, { archived_at: "2026-01-01" }, { links: [] }]) {
    assert.deepEqual(documentActionIndex([{ ...doc, ...changed }], [source]).doc.reviews, []);
  }
});
