import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DOCUMENT_CHECK_RECIPIENT_ROLES, WEIGHT_TOLERANCE_MIN_KG, WEIGHT_TOLERANCE_SHARE, describeValues, findingTaskDescription,
  findingTaskTitle, parseDocumentCheck, summarizeFindings, weightToleranceKg,
} from "../../src/lib/document-check/rules.ts";

const SQL = readFileSync(new URL("../../supabase/migrations/202609276400_document_check_agent.sql", import.meta.url), "utf8");
const DOC = "11111111-1111-4111-8111-111111111111";
const finding = (overrides: Record<string, unknown> = {}) => ({
  key: "weight_mismatch:t:d:net_weight_kg:1000", code: "weight_mismatch", severity: "error",
  message: "Вес нетто в документе отличается от расчёта по товарам больше допуска",
  transport_no: 1, document_id: DOC, document_title: "CMR", field: "net_weight_kg",
  document_value: "1000 кг", card_value: "900 кг ± 50 кг", ...overrides,
});

describe("document check: rules shared with the database", () => {
  it("uses the agreed weight tolerance: the larger of 2 % and 50 kg", () => {
    assert.equal(weightToleranceKg(1000), 50);
    assert.equal(weightToleranceKg(2500), 50);
    assert.equal(weightToleranceKg(10_000), 200);
    assert.match(SQL, new RegExp(`greatest\\(abs\\(p_expected\\) \\* ${WEIGHT_TOLERANCE_SHARE}, ${WEIGHT_TOLERANCE_MIN_KG}\\)`));
  });

  it("notifies the administrator, the director and every logistics role, as in the database", () => {
    const body = SQL.slice(SQL.indexOf("function private.document_check_recipient_roles"), SQL.indexOf("function private.document_check_weight_tolerance"));
    const roles = [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    assert.deepEqual(roles, [...DOCUMENT_CHECK_RECIPIENT_ROLES]);
  });

  it("sends notifications only inside Nexus and never calls anything outside the database", () => {
    assert.doesNotMatch(SQL, /telegram|http|net\.http|pg_net/i);
    assert.match(SQL, /private\.notify\(v_recipient, 'discrepancy'/);
  });

  it("writes nothing but its own state and notifications", () => {
    const writes = [...SQL.matchAll(/\b(insert into|update|delete from)\s+public\.(\w+)/gi)].map((match) => match[2]);
    assert.deepEqual([...new Set(writes)].sort(), ["shipment_document_checks"]);
  });
});

describe("document check: reading the result", () => {
  it("parses findings and drops malformed rows", () => {
    const check = parseDocumentCheck({
      findings: [finding(), { code: "x" }, null, finding({ key: "k2", severity: "warning", document_id: "../x", transport_no: "abc" })],
      last_run_at: "2026-10-12T05:00:00Z", last_run_source: "daily",
    });
    assert.equal(check.findings.length, 2);
    assert.equal(check.findings[0].documentId, DOC);
    assert.equal(check.findings[1].documentId, undefined, "only ids become links");
    assert.equal(check.findings[1].transportNo, undefined);
    assert.deepEqual([check.lastRunAt, check.lastRunSource], ["2026-10-12T05:00:00Z", "daily"]);
    assert.deepEqual(parseDocumentCheck(null), { findings: [], lastRunAt: null, lastRunSource: null });
  });

  it("summarizes the state as green, yellow or red", () => {
    const parse = (rows: unknown[]) => parseDocumentCheck({ findings: rows }).findings;
    assert.deepEqual(summarizeFindings([]), { state: "ok", errors: 0, warnings: 0 });
    assert.deepEqual(summarizeFindings(parse([finding({ severity: "warning" })])), { state: "warning", errors: 0, warnings: 1 });
    assert.deepEqual(summarizeFindings(parse([finding(), finding({ key: "b", severity: "warning" })])), { state: "error", errors: 1, warnings: 1 });
  });

  it("explains compared values and dates", () => {
    const [weight, expiry, missing] = parseDocumentCheck({ findings: [
      finding(),
      finding({ key: "e", code: "document_expires_before_arrival", field: "valid_until", document_value: "2026-10-15", card_value: "2026-10-20" }),
      finding({ key: "m", code: "document_missing", severity: "warning", field: "cmr", document_value: "CMR", card_value: undefined }),
    ] }).findings;
    assert.equal(describeValues(weight), "в документе: 1000 кг · расчёт: 900 кг ± 50 кг");
    assert.equal(describeValues(expiry), "действует до 15.10.2026 · плановое прибытие 20.10.2026");
    assert.equal(describeValues(missing), null);
  });

  it("builds the task text from the finding, within the database limits", () => {
    const [item] = parseDocumentCheck({ findings: [finding()] }).findings;
    assert.equal(findingTaskTitle(item, "NAR-2026-0007"), "Документы NAR-2026-0007, автомобиль №1: Вес нетто в документе отличается от расчёта по товарам больше допуска");
    assert.ok(findingTaskTitle({ ...item, message: "x".repeat(400) }, "N").length <= 200);
    assert.match(findingTaskDescription(item), /Документ: CMR\nв документе: 1000 кг/);
  });
});
