import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOperationalSummary } from "../../src/lib/analytics/summary.ts";

describe("operational summary from the database", () => {
  it("reads the counts beyond the 1000 rows a list request returns", () => {
    const summary = parseOperationalSummary({
      today: "2026-10-14",
      shipments: { total: 1204, active: 1100, late: 3, by_status: { in_transit: 900, planning: 200, closed: 104 } },
      stages: { blocked: 2, late: 1500, attention: 1501 },
      sales: { total: 2500, open: 40, late: 0, by_status: { shipped: 2460, reserved: 40, draft: 0 } },
      inventory: { risk: 7 },
      tasks: { open: 1200, late: 5 },
    });
    assert.equal(summary.today, "2026-10-14");
    assert.deepEqual(summary.shipments, { total: 1204, active: 1100, late: 3, byStatus: [["in_transit", 900], ["planning", 200], ["closed", 104]] });
    assert.deepEqual(summary.stages, { blocked: 2, late: 1500, attention: 1501 });
    assert.deepEqual(summary.sales?.byStatus, [["shipped", 2460], ["reserved", 40]], "a status with no rows is not shown");
    assert.deepEqual(summary.inventory, { risk: 7 });
    assert.deepEqual(summary.tasks, { open: 1200, late: 5 });
  });

  it("leaves out a block without permission and a malformed one, instead of showing zero", () => {
    const summary = parseOperationalSummary({ today: "14.10.2026", stages: { blocked: 1, late: "x", attention: 1 }, tasks: { open: -1, late: 0 } });
    assert.equal(summary.today, null);
    assert.equal(summary.shipments, null);
    assert.equal(summary.stages, null);
    assert.equal(summary.sales, null);
    assert.equal(summary.inventory, null);
    assert.equal(summary.tasks, null);
    assert.deepEqual(parseOperationalSummary(null), { today: null, shipments: null, stages: null, sales: null, inventory: null, tasks: null });
  });

  it("accepts counts sent as numeric strings and orders statuses by count", () => {
    const summary = parseOperationalSummary({ sales: { total: "3", open: "2", late: "1", by_status: { confirmed: "1", draft: "2" } } });
    assert.deepEqual(summary.sales, { total: 3, open: 2, late: 1, byStatus: [["draft", 2], ["confirmed", 1]] });
  });
});
