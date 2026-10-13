import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingRequiredDocuments, type RequirementContext } from "../../src/lib/shipment-report-rules.ts";

const CMR = "type-cmr", INVOICE = "type-invoice";
const T1 = { id: "t1", sequence_no: 1, status: "in_transit" }, T2 = { id: "t2", sequence_no: 2, status: "planned" };
const base = (overrides: Partial<RequirementContext> = {}): RequirementContext => ({
  shipment: { type: "import", process_template_id: "tpl", route_id: "route" },
  stageIds: new Set(["stage-docs"]),
  documents: [], links: [], transports: [T1, T2],
  ...overrides,
});
const requirements = [
  { document_type_id: INVOICE, is_mandatory: true, applies_to: "shipment" },
  { document_type_id: CMR, is_mandatory: true, applies_to: "shipment_transport" },
];
const doc = (id: string, type: string, status = "approved") => ({ id, document_type_id: type, status });
const link = (document_id: string, entity_type: string, entity_id: string) => ({ document_id, entity_type, entity_id });
const summary = (result: ReturnType<typeof missingRequiredDocuments>) =>
  result.map(({ requirement, transport }) => `${requirement.document_type_id}${transport ? `@${transport.sequence_no}` : ""}`);

describe("shipment report: mandatory documents", () => {
  it("requires a vehicle document for every vehicle, not once per shipment", () => {
    const context = base({ documents: [doc("d1", INVOICE), doc("d2", CMR)], links: [link("d1", "shipment", "s"), link("d2", "shipment_transport", "t1")] });
    assert.deepEqual(summary(missingRequiredDocuments(requirements, context)), ["type-cmr@2"]);
  });

  it("counts a shipment document for the only vehicle, but not when there are several", () => {
    const docs = [doc("d1", INVOICE), doc("d2", CMR)];
    const links = [link("d1", "shipment", "s"), link("d2", "shipment", "s")];
    assert.deepEqual(summary(missingRequiredDocuments(requirements, base({ documents: docs, links, transports: [T1] }))), []);
    assert.deepEqual(summary(missingRequiredDocuments(requirements, base({ documents: docs, links }))), ["type-cmr@1", "type-cmr@2"]);
  });

  it("ignores cancelled vehicles and links to vehicles of other shipments", () => {
    const docs = [doc("d1", INVOICE), doc("d2", CMR)];
    const context = base({ documents: docs, transports: [T1, { ...T2, status: "cancelled" }],
      links: [link("d1", "shipment_transport", "t1"), link("d2", "shipment_transport", "foreign")] });
    assert.deepEqual(summary(missingRequiredDocuments(requirements, context)), ["type-cmr@1"],
      "a vehicle document counts for the shipment requirement; a foreign link counts for nothing");
  });

  it("does not count rejected documents and reports each requirement once", () => {
    const context = base({ transports: [], documents: [doc("d1", INVOICE, "rejected")], links: [link("d1", "shipment", "s")] });
    assert.deepEqual(summary(missingRequiredDocuments([...requirements, requirements[0]], context)), ["type-invoice"]);
  });

  it("applies only mandatory requirements of this shipment's type, process, route and stages", () => {
    const other = [
      { document_type_id: "a", is_mandatory: false },
      { document_type_id: "b", is_mandatory: true, shipment_type: "export" },
      { document_type_id: "c", is_mandatory: true, process_template_id: "other" },
      { document_type_id: "d", is_mandatory: true, route_id: "other" },
      { document_type_id: "e", is_mandatory: true, stage_id: "stage-of-another-process" },
      { document_type_id: "f", is_mandatory: true, stage_id: "stage-docs" },
    ];
    assert.deepEqual(summary(missingRequiredDocuments(other, base())), ["f"]);
  });
});
