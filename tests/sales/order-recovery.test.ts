import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CURRENT_LETTER_STATUSES, FIXED_LETTER_STATUSES, GUARANTEE_STATUS_LABELS, canReschedule, describeRevision, reservationMode, reservationProblems, shipmentDay,
} from "../../src/lib/sales/order-recovery.ts";

const SQL = readFileSync(new URL("../../supabase/migrations/202609278100_confirmed_order_recovery.sql", import.meta.url), "utf8");
const reservation = (overrides: Record<string, unknown> = {}) => ({
  batchNumber: "LOT-1", batchStatus: "available", expiryDate: "2026-12-31", remainingPct: 80, requiredPct: 70, ...overrides,
});

describe("guarantee letters", () => {
  it("labels every status the database allows and agrees on which letters are current", () => {
    const statuses = /guarantee_letters_status_check\s+check\(status in \(([^)]*)\)\)/.exec(SQL)?.[1].match(/'(\w+)'/g)?.map((value) => value.slice(1, -1));
    assert.deepEqual(statuses, ["draft", "approved", "sent", "accepted", "rejected", "cancelled", "superseded"]);
    for (const status of statuses ?? []) assert.ok(GUARANTEE_STATUS_LABELS[status], status);
    const current = /guarantee_letters_current_key[^;]*where status in \(([^)]*)\)/.exec(SQL)?.[1].match(/'(\w+)'/g)?.map((value) => value.slice(1, -1));
    assert.deepEqual([...CURRENT_LETTER_STATUSES].sort(), [...(current ?? [])].sort());
    assert.deepEqual([...FIXED_LETTER_STATUSES].sort(), ["accepted", "approved", "sent"]);
  });
});

describe("what blocks a shipment", () => {
  it("checks the planned date, or today once it has passed", () => {
    assert.equal(shipmentDay("2026-10-20", "2026-10-14"), "2026-10-20");
    assert.equal(shipmentDay("2026-10-10", "2026-10-14"), "2026-10-14");
  });

  it("names blocked, quarantined and expiring batches", () => {
    const problems = reservationProblems([
      reservation({ batchNumber: "B", batchStatus: "blocked" }),
      reservation({ batchNumber: "Q", batchStatus: "quarantine" }),
      reservation({ batchNumber: "E", expiryDate: "2026-10-19" }),
      reservation({ batchNumber: "OK", expiryDate: "2026-10-20" }),
    ], "2026-10-20", "2026-10-14", false);
    assert.deepEqual(problems.map((p) => [p.kind, p.batchNumber]), [["batch_unavailable", "B"], ["batch_unavailable", "Q"], ["expired", "E"]]);
    assert.match(problems[0].text, /B заблокирована/);
    assert.match(problems[1].text, /Q в карантине/);
  });

  it("asks for a letter only while no fixed letter exists", () => {
    const low = [reservation({ remainingPct: 73, requiredPct: 74 })];
    assert.equal(reservationProblems(low, "2026-10-20", "2026-10-14", false)[0].kind, "low_shelf_life");
    assert.deepEqual(reservationProblems(low, "2026-10-20", "2026-10-14", true), []);
    assert.deepEqual(reservationProblems([reservation({ requiredPct: null })], "2026-10-20", "2026-10-14", false), []);
  });
});

describe("how an order is changed", () => {
  it("re-reserves confirmed orders and orders with a fixed letter, with a reason", () => {
    assert.equal(reservationMode("draft", false), "reserve");
    assert.equal(reservationMode("reserved", false), "reserve");
    assert.equal(reservationMode("reserved", true), "rereserve");
    assert.equal(reservationMode("confirmed", false), "rereserve");
    assert.equal(reservationMode("shipped", false), null);
    assert.equal(reservationMode("cancelled", true), null);
    assert.deepEqual(["draft", "reserved", "confirmed", "shipped", "cancelled"].map(canReschedule), [true, true, true, false, false]);
  });

  it("describes replacements and moves for the history", () => {
    assert.deepEqual(describeRevision({ action: "rereserve", reason: "Отзыв производителя",
      details: { before: [{ batch_number: "A" }, { batch_number: "A" }], after: [{ batch_number: "B" }, { batch_number: "C" }], fefo: true, letter_superseded: false } }),
      { title: "Партии заменены по FEFO: A → B, C", detail: "Отзыв производителя." });
    assert.deepEqual(describeRevision({ action: "rereserve", reason: "Свежая партия", details: { before: [], after: [{ batch_number: "D" }], fefo: false, letter_superseded: true } }),
      { title: "Партии заменены вручную: — → D", detail: "Свежая партия. Гарантийное письмо заменено." });
    assert.deepEqual(describeRevision({ action: "reschedule", reason: "Машина опаздывает",
      details: { from: "2026-10-19", to: "2026-10-21", unfit_batches: "OR-1", letter_superseded: false } }),
      { title: "Отгрузка перенесена с 19.10.2026 на 21.10.2026", detail: "Машина опаздывает. Непригодны к новой дате: OR-1." });
    assert.deepEqual(describeRevision({ action: "reschedule", reason: "x", details: null }), { title: "Отгрузка перенесена с — на —", detail: "x." });
  });
});
