import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptMessage, groupByShipment, parseProposals, safeReturnPath } from "../../src/lib/logist/proposals.ts";

const row = (id: string, shipment: string, number: string, created: string) => ({
  id, shipment_id: shipment, kind: "complete_stage", title: "Завершить этап", reason: "Документы на месте", status: "pending",
  created_at: created, decided_at: null, decision_note: null, shipment: [{ shipment_number: number, project_code: null }], decider: null,
});

describe("Logist proposals", () => {
  it("reads relations that come as arrays", () => {
    const [proposal] = parseProposals([row("p1", "s1", "NAR-1", "2026-10-13T10:00:00Z")]);
    assert.equal(proposal.shipment?.shipment_number, "NAR-1");
    assert.equal(proposal.decider, null);
  });

  it("groups by shipment, the longest waiting first", () => {
    const groups = groupByShipment(parseProposals([
      row("p1", "s2", "NAR-2", "2026-10-13T11:00:00Z"),
      row("p2", "s1", "NAR-1", "2026-10-13T09:00:00Z"),
      row("p3", "s2", "NAR-2", "2026-10-13T08:00:00Z"),
    ]));
    assert.deepEqual(groups.map(group => [group.label, group.proposals.map(p => p.id)]), [["NAR-2", ["p3", "p1"]], ["NAR-1", ["p2"]]]);
  });

  it("explains an obsolete proposal instead of reporting success", () => {
    assert.equal(acceptMessage({ status: "obsolete" }).kind, "error");
    assert.equal(acceptMessage({ status: "accepted" }).kind, "success");
  });

  it("returns only to pages of Nexus", () => {
    assert.equal(safeReturnPath("/logist"), "/logist");
    assert.equal(safeReturnPath("/shipments/a1a1a1a1-1111-4111-8111-111111111111?tab=main"), "/shipments/a1a1a1a1-1111-4111-8111-111111111111?tab=main");
    assert.equal(safeReturnPath("https://example.com"), "/logist");
    assert.equal(safeReturnPath("//example.com/logist"), "/logist");
    assert.equal(safeReturnPath("/admin/users"), "/logist");
    assert.equal(safeReturnPath(null), "/logist");
  });
});
