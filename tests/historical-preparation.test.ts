import test from "node:test";
import assert from "node:assert/strict";
import { preparationPreview, preparationSourceValues } from "../src/lib/shipments/historical-preparation.ts";
import { preparationFixture } from "./fixtures/historical-preparation.ts";

test("complete synthetic set uses existing quantity matching and explicit source provenance", () => {
  const input = preparationFixture("complete"), before = JSON.stringify(input);
  const result = preparationPreview(input);
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows[0].quantities?.proposals[0].quantity, 965);
  assert.equal(result.rows[0].fields.find(f => f.key === "invoice_number")?.state, "confirmed");
  assert.match(result.rows[0].href, /doc-invoice.*v-invoice/);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(preparationPreview(input), result, "reopen and rescan are pure, no duplicate rows");
});
test("incomplete or truncated set never means ready, absent fields are not zero", () => {
  assert.equal(preparationPreview(preparationFixture("incomplete")).rows.length, 0);
  const input = preparationFixture("complete");
  assert.equal(preparationPreview(input).rows[0].fields.find(f => f.key === "gross_weight_kg")?.value, null);
  input.complete = false;
  const result = preparationPreview(input);
  assert.equal(result.rows.length, 0);
  assert.ok(result.actions.some(a => a.includes("полный доступный")));
});
test("two vehicles are separate; conflicting translation is neither merged nor added to quantity", () => {
  const result = preparationPreview(preparationFixture("conflicting"));
  assert.equal(result.rows.length, 8);
  assert.equal(result.rows.find(r => r.id === "cmr-a")?.fields.find(f => f.key === "cmr_number")?.state, "conflict");
  assert.equal(result.rows.find(r => r.id === "cmr-b")?.fields.find(f => f.key === "cmr_number")?.state, "confirmed");
  assert.equal(result.rows.find(r => r.id === "translation")?.choice.variant, "translation");
});
test("changed extraction resets classification; revoked/archived/version-replaced source is excluded", () => {
  const input = preparationFixture("complete"); input.sources[0].updated_at = "2026-10-21T11:00:00Z";
  const row = preparationPreview(input).rows[0]; assert.equal(row.stale, true); assert.equal(row.choice.group, "unknown");
  const d = input.sources[0].document; assert.ok(d && !Array.isArray(d));
  for (const change of [() => { d.archived_at = "2026-10-21"; }, () => { d.archived_at = null; d.status = "rejected"; }, () => { d.status = "approved"; d.versions[0].is_current = false; }, () => { d.versions[0].is_current = true; d.links = []; }]) {
    change(); assert.equal(preparationPreview(input).rows.some(r => r.id === "invoice"), false);
  }
});
test("names, language and plate never infer classification; unreviewed values remain documented", () => {
  const input = preparationFixture("complete"); input.choices = []; input.sources[0].status = "extracted";
  const result = preparationPreview(input);
  assert.ok(result.rows.every(r => r.choice.group === "unknown" && r.choice.variant === "unknown"));
  assert.equal(result.rows[0].fields.find(f => f.key === "invoice_number")?.state, "documented");
});
test("projection strips unknown text/metadata and malformed lines cannot supply quantities", () => {
  const input = preparationFixture("complete");
  input.sources[0].extracted_data = { raw_text: "NOT FOR CLIENT", invoice_number: "SYN-10", invoice_items: [null, { sku: 42, quantity: 100 }] };
  input.sources = input.sources.map(preparationSourceValues);
  assert.equal(JSON.stringify(input).includes("NOT FOR CLIENT"), false);
  const row = preparationPreview(input).rows[0];
  assert.equal(row.quantities?.proposals[0].quantity, null);
  assert.ok(row.quantities?.warnings.some(w => w.includes("повреждены")));
});
test("current invoice/packing evidence is projected once, with warnings preserved", () => {
  const input = preparationFixture("complete");
  input.sources[0].extracted_data.commodity_invoice = { number: "SYN-10", currency: "EUR", total: 965, warnings: [], items: [{ number: 1, sku: "SYN-A", description: "Synthetic", hsCode: null, quantity: 965, unit: "шт", amount: 965, grossKg: null, netKg: null, customsValue: null, warnings: [] }] };
  input.sources[1].extracted_data.packing_evidence = { number: "SYN-P10", total: 965, warnings: [], items: [{ sku: "SYN-A", quantity: 965, unit: "piece" }] };
  input.sources = input.sources.map(preparationSourceValues);
  let result = preparationPreview(input);
  assert.equal(result.rows[0].lines.length, 1, "legacy and current representations are not added");
  assert.equal(result.rows[1].lines[0].quantity, 965);
  assert.equal(result.rows[1].quantities?.proposals[0].quantity, 965);
  input.sources[0].readingWarnings = ["Synthetic incomplete table"];
  result = preparationPreview(input);
  assert.equal(result.rows[0].quantities?.proposals[0].quantity, null);
  assert.ok(result.rows[0].quantities?.warnings.includes("Synthetic incomplete table"));
});

test("Polish invoice pieces use the shared unit registry without changing source text", () => {
  const input = preparationFixture("complete");
  input.sources[0].extracted_data.commodity_invoice = { number: "SYN-10", currency: "EUR", total: 965, warnings: [], items: [{ number: 1, sku: "SYN-A", description: "Synthetic", hsCode: null, quantity: 965, unit: "sztuka", amount: 965, grossKg: null, netKg: null, customsValue: null, warnings: [] }] };
  input.sources = input.sources.map(preparationSourceValues);
  const before = JSON.stringify(input), row = preparationPreview(input).rows[0];
  assert.equal(row.quantities?.proposals[0].quantity, 965);
  assert.equal(row.lines[0].uom, "sztuka", "the original evidence unit remains visible");
  assert.equal(JSON.stringify(input), before);
  for (const unit of ["kg", "box", "unknown"]) {
    input.sources[0].extracted_data.invoice_items = [{ sku: "SYN-A", quantity: 965, uom: unit }];
    assert.equal(preparationPreview(input).rows[0].quantities?.proposals[0].quantity, null, "never infer pieces from weight or packaging");
  }
});

test("965 invoice / 960 packing is a conflict with both sources, not a receiving shortage", () => {
  const input = preparationFixture("complete");
  input.sources[1].extracted_data.invoice_items = [{ sku: "SYN-A", quantity: 960, uom: "шт" }];
  const before = JSON.stringify(input), result = preparationPreview(input);
  const a = result.rows[0].quantityConflicts[0], b = result.rows[1].quantityConflicts[0];
  assert.equal(a.quantity, 965); assert.equal(a.otherQuantity, 960);
  assert.equal(b.quantity, 960); assert.equal(b.otherQuantity, 965);
  assert.equal(a.otherHref, result.rows[1].href);
  assert.ok(result.actions.some(a => a.includes("есть расхождения")));
  assert.doesNotMatch(JSON.stringify(result.rows.map(r => r.quantityConflicts)), /недостача/i);
  assert.equal(JSON.stringify(input), before);
});

test("quantity comparison never combines copies or crosses operations and vehicle scopes", () => {
  const input = preparationFixture("complete");
  assert.equal(preparationPreview(input).rows[0].quantityConflicts.length, 0);
  input.sources[1].extracted_data.invoice_items = [{ sku: "SYN-A", quantity: 960, uom: "шт" }];
  input.choices[1].variant = "translation";
  assert.equal(preparationPreview(input).rows[0].quantityConflicts.length, 1, "translation disagreement remains visible");
  input.choices[1].group = "sale";
  assert.equal(preparationPreview(input).rows[0].quantityConflicts.length, 0);
  input.choices[1].group = "procurement";
  input.sources[1].shipment_transport_id = "a";
  input.items[0].shipment_transport_id = "a";
  assert.equal(preparationPreview(input).rows[0].quantityConflicts.length, 0, "whole shipment and a single vehicle are distinct scopes");
});

test("incomplete, ambiguous and unavailable evidence cannot create a quantity conflict", () => {
  const input = preparationFixture("complete");
  input.sources[1].extracted_data.invoice_items = [{ sku: "SYN-A", quantity: 960, uom: "шт" }];
  input.sources[1].readingWarnings = ["Partial source"];
  assert.equal(preparationPreview(input).rows[0].quantityConflicts.length, 0);
  input.sources[1].readingWarnings = [];
  input.sources[1].extracted_data.invoice_items = [{ sku: "UNKNOWN", quantity: 960, uom: "шт" }];
  assert.equal(preparationPreview(input).rows[0].quantityConflicts.length, 0);
  input.sources[1].extracted_data.invoice_items = [{ sku: "SYN-A", quantity: 960, uom: "шт" }];
  const document = input.sources[1].document;
  assert.ok(document && !Array.isArray(document)); document.archived_at = "2026-10-21";
  assert.equal(preparationPreview(input).rows[0].quantityConflicts.length, 0);
});
