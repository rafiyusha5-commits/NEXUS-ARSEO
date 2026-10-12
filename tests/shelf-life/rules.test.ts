import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DEFAULT_REQUIRED_PCT, customerAdvice, describeRequirement, formatQuantities, parseHorizon, parseShelfLifeRisks, summarizeRisks,
} from "../../src/lib/shelf-life/rules.ts";

const SQL = readFileSync(new URL("../../supabase/migrations/202609276500_shelf_life_control_agent.sql", import.meta.url), "utf8");
const BATCH = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "33333333-3333-4333-8333-333333333333";
const item = (overrides: Record<string, unknown> = {}) => ({
  batch_id: BATCH, product_id: PRODUCT, batch_number: "LOT-1", internal_sku: "SKU-1", product_name: "Сок",
  expiry_date: "2026-11-21", manufacture_date: "2026-08-13", remaining_pct: 40, quantities: [{ uom: "box", quantity: 80 }],
  warehouses: "AKT", state: "below", first_deadline: "2026-09-02",
  customers: [
    { customer_id: CUSTOMER, customer_name: "Клиент 1", required_pct: 30, source: "client", last_ok_day: "2026-10-22", state: "soon", guarantee_letter: false },
    { required_pct: 70, source: "default", last_ok_day: "2026-09-12", state: "below", guarantee_letter: true },
  ],
  ...overrides,
});

describe("Контроль ОСГ: rules shared with the database", () => {
  it("uses 70 % when a customer has no requirement, as the database does", () => {
    assert.equal(DEFAULT_REQUIRED_PCT, 70);
    assert.match(SQL, /function private\.shelf_life_default_pct\(\)[\s\S]*?select 70::numeric/);
  });

  it("takes the requirement from the product term, the contract, the customer card, then the default", () => {
    const body = SQL.slice(SQL.indexOf("function private.shelf_life_requirement"), SQL.indexOf("function private.shelf_life_risks"));
    assert.ok(body.indexOf("where product_id = p_product") < body.indexOf("where product_id is null"));
    assert.ok(body.indexOf("where product_id is null") < body.indexOf("cp.min_remaining_shelf_life_pct"));
    assert.ok(body.indexOf("cp.min_remaining_shelf_life_pct") < body.indexOf("private.shelf_life_default_pct()"));
  });

  it("sends its summary only inside Nexus and writes nothing but notifications", () => {
    assert.doesNotMatch(SQL, /telegram|http|pg_net|googleapis/i);
    assert.deepEqual([...SQL.matchAll(/\b(insert into|update|delete from)\s+public\.(\w+)/gi)], []);
    assert.match(SQL, /private\.notify\(v_user, 'low_shelf_life'/);
  });
});

describe("Контроль ОСГ: reading the forecast", () => {
  it("parses batches and customers and drops malformed rows", () => {
    const risks = parseShelfLifeRisks({ today: "2026-10-12", horizon_days: 30, unknown_count: 2,
      items: [item(), item({ batch_id: "../x" }), item({ state: "weird" }), null] });
    assert.equal(risks.items.length, 1);
    assert.equal(risks.unknownCount, 2);
    const [batch] = risks.items;
    assert.equal(batch.customers.length, 2);
    assert.equal(batch.customers[0].customerId, CUSTOMER);
    assert.equal(batch.customers[1].customerName, undefined);
    assert.deepEqual(parseShelfLifeRisks(null), { today: null, horizonDays: 30, items: [], unknownCount: 0 });
  });

  it("explains the requirement and what to do for each customer", () => {
    const [batch] = parseShelfLifeRisks({ items: [item()] }).items;
    assert.equal(describeRequirement(batch.customers[0]), "Клиент 1 — требование 30 % (карточка клиента)");
    assert.equal(describeRequirement(batch.customers[1]), "Любой клиент — требование 70 % (по умолчанию)");
    assert.equal(customerAdvice(batch.customers[0], false), "Отгрузить до 22.10.2026 включительно.");
    assert.equal(customerAdvice(batch.customers[1], false), "Требование не выполняется с 13.09.2026. Продажа возможна только с гарантийным письмом клиента.");
    assert.match(customerAdvice(batch.customers[0], true), /Срок годности истёк/);
    assert.equal(formatQuantities(batch.quantities), "80 кор.");
  });

  it("shows hidden customers as one anonymous line with their real risk", () => {
    const [batch] = parseShelfLifeRisks({ items: [item({ customers: [
      { hidden_count: 2, last_ok_day: "2026-10-07", state: "below", guarantee_letter: true, customer_name: "leak", customer_id: CUSTOMER, required_pct: 90, source: "client" },
    ] })] }).items;
    const [hidden] = batch.customers;
    assert.equal(hidden.hiddenCount, 2);
    assert.deepEqual([hidden.customerId, hidden.customerName, hidden.requiredPct, hidden.source, hidden.lastOkDay], [undefined, undefined, null, null, null], "nothing hidden is kept even if sent");
    assert.equal(describeRequirement(hidden), "Клиенты, карточки которых вам недоступны: 2 — их требования учтены в оценке риска");
    assert.equal(customerAdvice(hidden, false), "Для части этих клиентов требование уже не выполняется: продажа им возможна только с гарантийным письмом. Названия клиентов, их требования и сроки отгрузки видны сотрудникам с правом просмотра покупателей.");
    assert.doesNotMatch(customerAdvice({ ...hidden, state: "soon", guaranteeLetter: false }, false), /\d{2}\.\d{2}\.\d{4}/, "no date for hidden customers");
  });

  it("keeps an unknown remaining shelf life unknown", () => {
    const [batch] = parseShelfLifeRisks({ items: [item({ remaining_pct: null, manufacture_date: null, state: "expired", customers: [] })] }).items;
    assert.equal(batch.remainingPct, null);
    assert.equal(batch.customers.length, 0);
  });

  it("counts states and accepts only the offered horizons", () => {
    const { items } = parseShelfLifeRisks({ items: [item(), item({ batch_id: "44444444-4444-4444-8444-444444444444", state: "soon" })] });
    assert.deepEqual(summarizeRisks(items), { total: 2, expired: 0, below: 1, soon: 1 });
    assert.equal(parseHorizon("60"), 60);
    assert.equal(parseHorizon("1000"), 30);
    assert.equal(parseHorizon(undefined), 30);
  });
});
