import assert from "node:assert/strict";
import { test } from "node:test";
import { browserEvidenceProblems } from "./historical-contract.ts";

const evidence = () => ({
  fullBrowserE2E: true, twoTabWrites: true, manualConfirmationsPreserved: true, fourDocumentTypesParsed: true,
  missingSecondCmrDetected: true, bothCmrsPresent: true, permissionBoundary: true,
  cost: { goods: 346, expenses: 50, total: 396, status: "approved" },
  checkpoints: [
    ["received", 147, 0, 0, 3], ["reserved", 147, 0, 70, 3], ["transferred", 147, 0, 70, 5],
    ["shipped", 77, 0, 0, 7], ["returned", 77, 1, 0, 8], ["closed", 77, 1, 0, 8],
  ].map(([stage, piece, box, reserved, movements]) => ({ stage, stock: { piece, box }, reserved, movements, receipts: 2 })),
});
test("readiness rejects partial SQL/component evidence and every omitted browser boundary", () => {
  assert.ok(browserEvidenceProblems(null).length);
  assert.ok(browserEvidenceProblems({ fullBrowserE2E: true }).length);
  assert.deepEqual(browserEvidenceProblems(evidence()), []);
  for (const key of ["fullBrowserE2E", "twoTabWrites", "manualConfirmationsPreserved", "fourDocumentTypesParsed",
    "missingSecondCmrDetected", "bothCmrsPresent", "permissionBoundary"]) {
    assert.ok(browserEvidenceProblems({ ...evidence(), [key]: false }).length, key);
  }
});
test("readiness refuses duplicated stock/movements, missing stages and unapproved costing", () => {
  const report = evidence();
  report.checkpoints[3].movements = 9;
  assert.ok(browserEvidenceProblems(report).length);
  assert.ok(browserEvidenceProblems({ ...evidence(), checkpoints: evidence().checkpoints.slice(1) }).length);
  assert.ok(browserEvidenceProblems({ ...evidence(), cost: { ...evidence().cost, status: "draft" } }).length);
});
