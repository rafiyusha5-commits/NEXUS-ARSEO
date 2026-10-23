import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperationIntent, operationError, OPERATION_KINDS } from "../../src/lib/agent/operations.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
import { FakeLedger, ScriptedProvider, fakeData, ALL_PERMISSIONS, permissionsOf, TEST_LIMITS, TEST_PRICING, USER_ID } from "./fakes.ts";
const command = { kind: "inventory_transfer", params: {
 product_id: "10000000-0000-4000-8000-000000000001", from_warehouse_id: "10000000-0000-4000-8000-000000000002",
 to_warehouse_id: "10000000-0000-4000-8000-000000000003", quantity: "10", uom: "box",
} };
test("commands use explicit quantities, identities and units", () => {
 assert.deepEqual(parseOperationIntent(command), command);
 for (const quantity of ["0", "-1", "NaN", "1e3", "0.0001", "10 boxes", 10])
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, quantity } }), null);
});
test("model cannot select SQL, RPC, Google writes or confirmation", () => {
 for (const kind of ["confirm", "execute_sql", "rpc", "drive.upload", "sheets.update", "fulfill_customer_order"])
  assert.equal(parseOperationIntent({ ...command, kind }), null);
 assert.deepEqual(OPERATION_KINDS, ["inventory_transfer", "customer_order_fulfillment", "customer_order_create", "customer_order_reserve"]);
 assert.equal(parseOperationIntent({ ...command, confirmed: true }), null);
 assert.equal(parseOperationIntent({ ...command, params: { ...command.params, rpc: "delete" } }), null);
});

test("order shipment is a closed proposal, not a price/quantity/reserve edit", () => {
 const order = { kind: "customer_order_fulfillment", params: { sale_id: command.params.product_id } };
 assert.deepEqual(parseOperationIntent(order), order);
 for (const params of [{ sale_id: "заказ 12" }, {}, { ...order.params, quantity: "1" }, { ...order.params, confirmed: true }, { ...order.params, price: 100 }])
  assert.equal(parseOperationIntent({ ...order, params }), null);
});

test("reservation proposal cannot waive a hard blocker or approve a letter", () => {
 const reserve = { kind: "customer_order_reserve", params: { sale_id: command.params.product_id } };
 assert.deepEqual(parseOperationIntent(reserve), reserve);
 for (const extra of [{ ignore: true }, { approve_letter: true }, { confirmed: true }, { quantity: "2" }, { low_shelf_life: false }])
  assert.equal(parseOperationIntent({ ...reserve, params: { ...reserve.params, ...extra } }), null);
});

const draft = { kind: "customer_order_create", params: {
 customer_id: command.params.product_id, warehouse_id: command.params.from_warehouse_id, currency_id: command.params.to_warehouse_id,
 contract_id: null, planned_shipment_date: "2099-01-20", items: [{ product_id: command.params.product_id, quantity: "2", uom: "box", unit_price: "100.1250" }],
} };
test("draft requires explicit currency, date, contract decision and exact prices", () => {
 assert.deepEqual(parseOperationIntent(draft), draft);
 for (const patch of [{ currency_id: null }, { contract_id: undefined }, { planned_shipment_date: "2099-02-30" }, { warehouse_id: "Астана" }, { confirm: true }])
  assert.equal(parseOperationIntent({ ...draft, params: { ...draft.params, ...patch } }), null);
 const noContract: Record<string, unknown> = { ...draft.params }; delete noContract.contract_id;
 assert.equal(parseOperationIntent({ ...draft, params: noContract }), null);
 for (const unit_price of [null, undefined, "", "-1", "1e3", "0.00001", 15, "10000000000"])
  assert.equal(parseOperationIntent({ ...draft, params: { ...draft.params, items: [{ ...draft.params.items[0], unit_price }] } }), null);
 assert.ok(parseOperationIntent({ ...draft, params: { ...draft.params, items: [{ ...draft.params.items[0], unit_price: "0" }] } })); // explicit zero is not missing
});
test("draft lines cannot be silently aggregated or smuggle a reserve/action", () => {
 for (const items of [[], Array(26).fill(draft.params.items[0]), [...draft.params.items, ...draft.params.items], [{ ...draft.params.items[0], reserve: true }]])
  assert.equal(parseOperationIntent({ ...draft, params: { ...draft.params, items } }), null);
 assert.ok(parseOperationIntent({ ...draft, params: { ...draft.params, items: [...draft.params.items, { ...draft.params.items[0], uom: "piece" }] } }));
 assert.ok(JSON.stringify({ action: "prepare", id: command.params.product_id, intent: { ...draft, params: { ...draft.params,
  items: Array.from({ length: 25 }, (_, i) => ({ ...draft.params.items[0], product_id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, quantity: "999999999.999", unit_price: "9999999999.9999" })) } } }).length < 8192);
});
test("ambiguous identities and unknown units fail closed", () => {
 for (const patch of [{ product_id: "Merba" }, { uom: "kg" }, { to_warehouse_id: command.params.from_warehouse_id }])
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, ...patch } }), null);
});
test("errors never forward database details or secrets", () => {
 assert.match(operationError({ message: "ASSISTANT_OPERATION_STALE" }), /изменились/);
 assert.doesNotMatch(operationError({ message: "SQL password=secret" }), /SQL|password|secret/);
});
test("model proposal alone never executes; Telegram and disabled mode discard it", async () => {
 for (const proposal of [command, draft, { kind: "customer_order_reserve", params: { sale_id: command.params.product_id } }]) for (const [channel, operationsEnabled] of [["web", true], ["web", false], ["telegram", true]] as const) {
  const ledger = new FakeLedger();
  const outcome = await runAgent("Подготовь перемещение двух коробов", {
   channel, operationsEnabled, userId: USER_ID, ledger, data: fakeData(), permissions: permissionsOf(ALL_PERMISSIONS), limits: TEST_LIMITS, pricing: TEST_PRICING,
   provider: new ScriptedProvider([{ content: JSON.stringify({ facts: [], commentary: [], limitations: [], operation: proposal }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }]),
  });
  assert.ok(outcome.ok);
  assert.equal(Boolean(outcome.answer.operationIntent), channel === "web" && operationsEnabled);
  assert.deepEqual(ledger.finished[0].tools, []);
 }
});
