import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_TOOLS, EXTRACTION_ALLOWED_FIELDS, TOOL_BY_NAME, localDate } from "../../src/lib/agent/tools.ts";
import type { ToolResult } from "../../src/lib/agent/types.ts";
import { DOCUMENT_ID, SECRET_VALUES, SHIPMENT_ID, USER_ID, fakeData } from "./fakes.ts";

async function run(name: string, params: Record<string, string | number>, data = fakeData()): Promise<ToolResult> {
  const tool = TOOL_BY_NAME.get(name)!;
  return tool.run({ userId: USER_ID, data, signal: new AbortController().signal }, params);
}

function assertNoSecrets(result: ToolResult) {
  const text = JSON.stringify(result);
  for (const [key, value] of Object.entries(SECRET_VALUES)) assert.ok(!text.includes(value), `${key} leaked`);
}

describe("assistant tools", () => {
  it("declare permissions, limits, timeouts and only declared fields", async () => {
    for (const tool of AGENT_TOOLS) {
      assert.ok(tool.maxRows > 0 && tool.maxRows <= 40, tool.name);
      assert.ok(tool.timeoutMs > 0 && tool.timeoutMs <= 10_000, tool.name);
      assert.ok(tool.fields.length > 0, tool.name);
    }
    assert.deepEqual(TOOL_BY_NAME.get("get_shipment_documents")!.permissions, ["shipments.view", "documents.view"]);
    assert.deepEqual(TOOL_BY_NAME.get("get_stock_status")!.permissions, ["inventory.view", "products.view", "warehouses.view"]);
  });

  it("find_shipments drops purchase prices and links rows by server-built references", async () => {
    const result = await run("find_shipments", { query: "NAR" });
    assertNoSecrets(result);
    assert.equal(result.rows[0].values.shipment_number, "NAR-2026-0007");
    assert.equal(result.rows[0].values.shipment_status, "В пути");
    assert.deepEqual(result.rows[0].entity, { type: "shipment", id: SHIPMENT_ID });
    assert.ok(!("unit_price" in result.rows[0].values));
  });

  it("get_shipment masks money and document numbers in reasons and returns no item prices", async () => {
    const result = await run("get_shipment", { shipment_id: SHIPMENT_ID });
    assertNoSecrets(result);
    const card = result.rows[0].values;
    assert.match(String(card.hold_reason), /\[скрыта сумма\]/);
    assert.ok(!("cancel_reason" in card), "cancel reason only for cancelled shipments");
    assert.equal(card.stages_total, 2);
    assert.ok(result.rows.some((row) => row.values.stage_status === "Заблокирован" && row.values.stage_reason === "Нет CMR"));
    assert.ok(result.rows.some((row) => row.values.ordered_quantity === 120));
  });

  it("counts unique shipment SKUs independently of item lines and stages", async () => {
    const data = fakeData({ async getShipmentItems() { return { rows: [{ internal_sku: "A" }, { internal_sku: "A" }, { internal_sku: "B" }], total: 3 }; } });
    const result = await run("get_shipment", { shipment_id: SHIPMENT_ID }, data);
    assert.equal(result.rows[0].values.sku_count, 2);
    assert.equal(result.rows[0].values.item_lines_total, 3);
    assert.equal(result.rows[0].values.stages_total, 2);
  });

  it("never presents an incomplete or unidentified SKU list as an exact total", async () => {
    for (const items of [
      { rows: [{ internal_sku: "A" }], total: 21 },
      { rows: [{ internal_sku: "A" }, { internal_sku: null }], total: 2 },
      { rows: [{ internal_sku: "A" }], total: null },
    ]) {
      const result = await run("get_shipment", { shipment_id: SHIPMENT_ID }, fakeData({ async getShipmentItems() { return items; } }));
      assert.ok(!("sku_count" in result.rows[0].values));
      assert.ok(result.notes.some((note) => note.includes("Точное количество уникальных SKU не определено")));
    }
    const empty = await run("get_shipment", { shipment_id: SHIPMENT_ID }, fakeData({ async getShipmentItems() { return { rows: [], total: 0 }; } }));
    assert.equal(empty.rows[0].values.sku_count, 0);
  });

  it("get_shipment_vehicles never returns driver name, phone or document", async () => {
    const result = await run("get_shipment_vehicles", { shipment_id: SHIPMENT_ID });
    assertNoSecrets(result);
    assert.equal(result.rows[0].values.vehicle_plate, "123ABC02");
    assert.ok(result.notes.some((note) => note.includes("водителя")));
  });

  it("get_shipment_documents hides amounts and the titles and numbers of driver documents", async () => {
    const result = await run("get_shipment_documents", { shipment_id: SHIPMENT_ID });
    assertNoSecrets(result);
    assert.ok(result.rows.some((row) => row.values.missing_document_type === "CMR"));
    const driver = result.rows.find((row) => row.values.document_type === "Документ водителя")!;
    assert.match(String(driver.values.document_title), /скрыто/);
    assert.ok(!("document_number" in driver.values));
    assert.equal(driver.values.attached_to, "Автомобиль 1");
  });

  it("get_document_extraction returns only allow-listed fields: no ESF prices, driver data, requisites or raw OCR", async () => {
    const result = await run("get_document_extraction", { shipment_id: SHIPMENT_ID });
    assertNoSecrets(result);
    const values = result.rows[0].values;
    for (const key of Object.keys(values)) {
      assert.ok(key in EXTRACTION_ALLOWED_FIELDS || ["document_title", "source_kind", "extraction_status", "extraction_method", "data_state", "conflict_fields"].includes(key), key);
    }
    assert.equal(values.gross_weight_kg, 1520.5);
    assert.equal(values.data_state, "Предложение распознавания, не подтверждено");
    assert.equal(values.conflict_fields, "Вес брутто, кг", "conflicts on forbidden fields are not named");
    assert.ok(!("invoice_items" in values) && !("payment_terms" in values) && !("bank_details" in values));
    assert.deepEqual(result.rows[0].entity, { type: "document", id: DOCUMENT_ID });
  });

  it("list_delayed_shipments states its definition and that the list is incomplete", async () => {
    const result = await run("list_delayed_shipments", {});
    assert.equal(result.truncated, true, "3 delayed shipments but 1 row returned");
    assert.equal(result.total, 3);
    assert.ok(result.notes[0].includes("Asia/Aqtobe"));
    assert.ok(typeof result.rows[0].values.days_late === "number");
  });

  it("get_stock_status aggregates batches, drops costs and says that a minimum stock does not exist", async () => {
    const result = await run("get_stock_status", {});
    assertNoSecrets(result);
    assert.equal(result.rows[0].values.quantity_available, 11);
    assert.equal(result.rows[0].values.nearest_expiry_date, "2026-11-01");
    assert.equal(result.rows[0].values.worst_shelf_life_state, "До 30 дней");
    assert.ok(result.notes.some((note) => note.includes("Минимальный остаток для товаров в Nexus не задан")));
  });

  it("get_my_tasks uses the session user, not a model parameter, and masks phones in titles", async () => {
    let seenUser = "";
    const data = fakeData({ async getMyTasks(input) { seenUser = input.userId; return { rows: [{ id: "x", title: `Позвонить ${SECRET_VALUES.driverPhone}`, status: "open" }], total: 1 }; } });
    const result = await run("get_my_tasks", { filter: "overdue" }, data);
    assert.equal(seenUser, USER_ID);
    assert.ok(!("user_id" in TOOL_BY_NAME.get("get_my_tasks")!.params));
    assertNoSecrets(result);
  });

  it("get_help returns curated text without secrets or setup instructions", async () => {
    for (const topic of ["assistant", "shipments", "vehicles", "documents", "recognition", "tasks", "stock", "limits"]) {
      const text = JSON.stringify(await run("get_help", { topic }));
      assert.doesNotMatch(text, /KEY|SECRET|service_role|миграц|SQL|DATABASE_URL|\.env/i);
    }
  });

  it("computes the business day in Asia/Aqtobe (UTC+5)", () => {
    assert.equal(localDate(new Date("2026-10-07T19:30:00Z")), "2026-10-08");
    assert.equal(localDate(new Date("2026-10-07T18:59:00Z")), "2026-10-07");
  });
});
