import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPIRING_SOON_DAYS,
  applicableRequirements,
  documentExpiry,
  parseLinkValue,
  requirementCoverage,
  sanitizeSearchTerm,
  todayIso,
  validateLinks,
} from "../../src/lib/documents/rules.ts";

describe("document expiry", () => {
  const today = "2026-09-27";

  it("marks documents without a validity date as not applicable", () => {
    assert.equal(documentExpiry(null, today).state, "none");
    assert.equal(documentExpiry("not-a-date", today).state, "none");
  });

  it("treats the last valid day as still valid, the next day as expired", () => {
    assert.deepEqual(documentExpiry("2026-09-27", today), { state: "expiring", daysLeft: 0 });
    assert.deepEqual(documentExpiry("2026-09-26", today), { state: "expired", daysLeft: -1 });
  });

  it("warns within the expiring window and not after it", () => {
    assert.equal(documentExpiry("2026-10-27", today).state, "expiring");
    assert.equal(documentExpiry("2026-10-27", today).daysLeft, EXPIRING_SOON_DAYS);
    assert.equal(documentExpiry("2026-10-28", today).state, "valid");
  });

  it("uses the Kazakhstan calendar date, not UTC", () => {
    assert.equal(todayIso(new Date("2026-09-26T20:30:00Z")), "2026-09-27");
  });
});

describe("shipment document requirements", () => {
  const shipment = { type: "import", process_template_id: "t-eu", route_id: "r-fi-kz" };
  const base = { applies_to: "shipment", shipment_type: null, process_template_id: null, route_id: null, is_mandatory: true, is_active: true };
  const requirements = [
    { ...base, id: "1", document_type_id: "invoice", process_template_id: "t-eu" },
    { ...base, id: "2", document_type_id: "cmr", shipment_type: "import" },
    { ...base, id: "3", document_type_id: "certificate", is_mandatory: false },
    { ...base, id: "4", document_type_id: "snt", shipment_type: "export" },
    { ...base, id: "5", document_type_id: "customs", route_id: "r-tr-kz" },
    { ...base, id: "6", document_type_id: "old", is_active: false },
    { ...base, id: "7", document_type_id: "transport_only", applies_to: "shipment_transport" },
  ];

  it("keeps only active shipment requirements whose filters match", () => {
    const ids = applicableRequirements(requirements, shipment).map((requirement) => requirement.id);
    assert.deepEqual(ids, ["1", "2", "3"]);
  });

  it("lists mandatory document types that have no linked document", () => {
    const applicable = applicableRequirements(requirements, shipment);
    const coverage = requirementCoverage(applicable, ["invoice"]);
    assert.deepEqual(coverage.missingMandatory, ["cmr"]);
    assert.equal(coverage.byType.get("certificate")?.mandatory, false);
  });

  it("treats a type as mandatory if any matching rule is mandatory", () => {
    const coverage = requirementCoverage(
      [
        { ...base, id: "a", document_type_id: "invoice", is_mandatory: false },
        { ...base, id: "b", document_type_id: "invoice", is_mandatory: true },
      ],
      [],
    );
    assert.deepEqual(coverage.missingMandatory, ["invoice"]);
  });
});

describe("search term sanitizing", () => {
  it("removes characters that would change a PostgREST filter", () => {
    const term = sanitizeSearchTerm("INV-1),status.eq.approved,(title.ilike.*");
    assert.doesNotMatch(term, /[,()*]/);
  });

  it("keeps ordinary numbers and Cyrillic text", () => {
    assert.equal(sanitizeSearchTerm("  CMR №  45/2026  "), "CMR № 45/2026");
    assert.equal(sanitizeSearchTerm("Инвойс Fazer"), "Инвойс Fazer");
  });

  it("limits the length", () => {
    assert.equal(sanitizeSearchTerm("x".repeat(500)).length, 80);
  });
});

describe("links", () => {
  const id = "c0000000-0000-4000-8000-000000000001";

  it("parses selector values and rejects unknown object types", () => {
    assert.deepEqual(parseLinkValue(`shipment:${id}`), { entity_type: "shipment", entity_id: id, link_role: "related" });
    assert.equal(parseLinkValue(`batch:${id}`), null, "batches belong to another module");
    assert.equal(parseLinkValue("shipment:../../x"), null);
    assert.equal(parseLinkValue(""), null);
  });

  it("rejects the same object twice and too many links", () => {
    const link = { entity_type: "shipment" as const, entity_id: id, link_role: "related" as const };
    assert.notEqual(validateLinks([link, { ...link, entity_id: id.toUpperCase() }]), null);
    const many = Array.from({ length: 21 }, (_, index) => ({
      ...link,
      entity_id: `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    assert.notEqual(validateLinks(many), null);
  });
});
