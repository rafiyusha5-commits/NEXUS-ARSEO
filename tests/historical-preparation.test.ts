import test from "node:test";
import assert from "node:assert/strict";
import { preparationPreview, preparationSourceValues } from "../src/lib/shipments/historical-preparation.ts";
import { preparationFixture } from "./fixtures/historical-preparation.ts";

test("complete synthetic set uses existing quantity matching and explicit source provenance", () => {
  const input = preparationFixture("complete"), before = JSON.stringify(input);
  const result = preparationPreview(input);
  assert.equal(result.rows.length, 3);
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
  assert.equal(result.rows.length, 5);
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
