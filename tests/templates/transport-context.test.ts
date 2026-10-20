import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfirmedSources } from "../../src/lib/document-extraction/rules.ts";
import { usableSourceContext, type ContextSource } from "../../src/lib/document-extraction/source-context.ts";
test("addresses and route countries of another vehicle cannot fill this vehicle's CMR", () => {
  const result = mergeConfirmedSources({ loading_address: "Own loading" }, [
    { transportId: "other", data: { loading_address: "Foreign loading", unloading_address: "Foreign unloading", loading_country: "ZZ", unloading_country: "YY", cmr_number: "FOREIGN" } },
  ], { transportId: "own", transportCount: 2 });
  assert.equal(result.loading_address, "Own loading");
  assert.equal(result.unloading_address, undefined);
  assert.equal(result.loading_country, undefined);
  assert.equal(result.cmr_number, undefined);
});
test("an existing shipment-wide route remains shared rather than being guessed onto a vehicle", () => {
  const result = mergeConfirmedSources({}, [{ transportId: null, data: { loading_address: "Shared contractual warehouse", vehicle_plate: "UNASSIGNED" } }],
    { transportId: "own", transportCount: 2 });
  assert.equal(result.loading_address, "Shared contractual warehouse");
  assert.equal(result.vehicle_plate, undefined);
});
test("generation excludes replaced, detached, rejected, hidden and other-operation documents", () => {
  const doc = { archived_at: null, status: "approved", current_version: 1, versions: [{ id: "v1", is_current: true, version_number: 1 }],
    links: [{ entity_type: "shipment", entity_id: "import", removed_at: null }] };
  const source: ContextSource = { status: "confirmed", document_version_id: "v1", document: doc };
  assert.equal(usableSourceContext(source, "import", ["truck"]), true);
  assert.equal(usableSourceContext(source, "export", ["truck2"]), false);
  assert.equal(usableSourceContext({ ...source, document: null }, "import", ["truck"]), false);
  for (const document of [{ ...doc, status: "rejected" }, { ...doc, archived_at: "2026-01-01" },
    { ...doc, current_version: 2 }, { ...doc, links: [] }]) {
    assert.equal(usableSourceContext({ ...source, document }, "import", ["truck"]), false);
  }
  assert.equal(usableSourceContext({ ...source, shipment_transport_id: "truck", document: { ...doc,
    links: [{ entity_type: "shipment_transport", entity_id: "truck2", removed_at: null }] } }, "import", ["truck", "truck2"]), false);
});
