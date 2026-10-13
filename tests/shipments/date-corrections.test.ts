import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { businessDay, readDateChanges } from "../../src/lib/shipments/date-corrections.ts";

const run = "a1a1a1a1-1111-4111-8111-111111111111";
const truck = "b2b2b2b2-2222-4222-8222-222222222222";
const receipt = "c3c3c3c3-3333-4333-8333-333333333333";

describe("real dates of an executed shipment", () => {
  it("shows a stored moment as the calendar day in Almaty", () => {
    assert.equal(businessDay("2026-08-01T20:30:00Z"), "2026-08-02", "after 19:00 UTC it is already the next day in Almaty");
    assert.equal(businessDay("2026-08-01T07:00:00Z"), "2026-08-01");
    assert.equal(businessDay("2026-08-01"), "2026-08-01");
    assert.equal(businessDay("2026-08-01T07:00:00.123456+00:00"), "2026-08-01", "database timestamps with microseconds");
    assert.equal(businessDay(null), "");
    assert.equal(businessDay("not a date"), "");
  });

  it("sends only the days the employee changed, grouped by record", () => {
    const { changes, count } = readDateChanges([
      [`stage_started_${run}`, "2026-08-01"], [`orig_stage_started_${run}`, "2026-10-13"],
      [`stage_completed_${run}`, "2026-08-03"], [`orig_stage_completed_${run}`, "2026-08-03"],
      [`transport_loading_${truck}`, ""], [`orig_transport_loading_${truck}`, ""],
      [`transport_arrival_${truck}`, "2026-07-30"], [`orig_transport_arrival_${truck}`, "2026-10-13"],
      [`receipt_${receipt}`, "2026-07-31"],
      ["reason", "Ввод прошедшей поставки"],
    ]);
    assert.equal(count, 3);
    assert.deepEqual(changes, {
      stages: [{ id: run, started_on: "2026-08-01" }],
      transports: [{ id: truck, actual_arrival_date: "2026-07-30" }],
      receipts: [{ id: receipt, received_on: "2026-07-31" }],
    });
  });

  it("refuses malformed days and records", () => {
    assert.throws(() => readDateChanges([[`receipt_${receipt}`, "31.07.2026"]]), /ГГГГ-ММ-ДД/);
    assert.throws(() => readDateChanges([["receipt_not-an-id", "2026-07-31"]]), /Некорректная запись/);
  });
});
