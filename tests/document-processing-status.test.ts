import { test } from "node:test";
import assert from "node:assert/strict";
import { processingState, processingErrorCode, processingErrors, processingDiagnostic, type ProcessingReceipt } from "../src/lib/documents/processing-status.ts";
test("crashed operation is actionable after lease expiry, never running forever", () => {
  const row: ProcessingReceipt = { id: "synthetic", kind: "import", state: "running", stage: "registering", started_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:01Z", lease_until: "2030-01-01T00:02:00Z", finished_at: null, error_code: null };
  assert.equal(processingState(row, Date.parse("2030-01-01T00:01:00Z")), "running");
  assert.equal(processingState(row, Date.parse("2030-01-01T00:03:00Z")), "needs_action");
  assert.equal(processingState({ ...row, state: "completed" }, Date.parse("2030-01-01T00:03:00Z")), "completed");
});
test("provider text, SQL, tokens and filenames never reach safe messages or diagnostics", () => {
  for (const stage of ["checking", "reading", "downloading", "storage", "registering", "finished"] as const) {
    const error = new Error("SQL private_table; Bearer SYNTH_SECRET; personal.txt; document text");
    const code = processingErrorCode(error, stage), diagnostic = processingDiagnostic("synthetic-id", stage, 1000, 1200, code);
    const rendered = JSON.stringify({ diagnostic, message: processingErrors[code] });
    for (const token of ["private_table", "SYNTH_SECRET", "personal.txt", "document text"]) assert.equal(rendered.includes(token), false);
    assert.equal(diagnostic.duration_ms, 200);
  }
  assert.equal(processingErrorCode(new Error("Файл изменён"), "downloading"), "SOURCE_CHANGED");
  assert.equal(processingErrorCode(new Error("Недостаточно прав"), "storage"), "ACCESS_DENIED");
  assert.equal(processingErrorCode(new Error("response lost"), "registering"), "SAVE_UNCERTAIN");
});

test("temporary failures wait for retry while uncertain results require employee review", () => {
  const row: ProcessingReceipt = { id: "synthetic", kind: "import", state: "failed", stage: "storage", started_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:01Z", lease_until: "2030-01-01T00:02:00Z", finished_at: "2030-01-01T00:00:01Z", error_code: "STORAGE_FAILED" };
  for (const error_code of ["STORAGE_FAILED", "SOURCE_UNAVAILABLE", "INTERRUPTED"] as const)
    assert.equal(processingState({ ...row, error_code }, 0), "waiting_retry");
  for (const error_code of ["SAVE_UNCERTAIN", "ACCESS_DENIED", "SESSION_EXPIRED", "SOURCE_CHANGED", "UNSUPPORTED"] as const)
    assert.equal(processingState({ ...row, error_code }, 0), "needs_action");
  assert.equal(processingState({ ...row, state: "completed" }, 0), "completed");
});
