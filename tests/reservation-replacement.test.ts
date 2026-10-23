import test from "node:test";
import assert from "node:assert/strict";
import { candidateWarning, replacementError } from "../src/lib/sales/reservation-replacement.ts";

const item = { id: "i", product_id: "p", sku: "SYNTH", quantity: 2, uom: "box", required_pct: 60 };
const order = { id: "s", status: "confirmed", date: "2099-03-01", today: "2099-01-01" };
const balance = { id: "b", product_id: "p", batch_number: "SYNTH", status: "available", expiry: "2099-12-01", uom: "piece", free: 20, pct: 80 };
test("replacement distinguishes quarantine, expiry on planned date and letter requirement", () => {
  assert.equal(candidateWarning(balance, item, order), null);
  assert.match(candidateWarning({ ...balance, status: "quarantine" }, item, order)!, /Карантин/);
  assert.match(candidateWarning({ ...balance, expiry: "2099-02-01" }, item, order)!, /до отгрузки/);
  assert.match(candidateWarning({ ...balance, pct: 50 }, item, order)!, /именно на эту позицию/);
  assert.match(candidateWarning(balance, item, { ...order, today: "2100-01-01" })!, /до отгрузки/);
});
test("safe replacement errors explain stale stock without exposing arbitrary finance or SQL", () => {
  assert.match(replacementError({ code: "P0001", message: "Остаток или состояние партий изменились. Обновите варианты" }), /Обновите/);
  assert.doesNotMatch(replacementError({ code: "P0001", message: "У покупателя долг 999999 EUR" }), /999999|EUR/);
  assert.doesNotMatch(replacementError({ code: "XX000", message: "secret_connection" }), /secret/);
  assert.match(replacementError({ code: "42501" }), /Недостаточно прав/);
});
