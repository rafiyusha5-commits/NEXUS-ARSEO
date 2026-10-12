import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANSWER_JSON_SCHEMA, parseAnswer, verifyAnswer, type CallRecord } from "../../src/lib/agent/facts.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import type { ToolResult } from "../../src/lib/agent/types.ts";
import { SHIPMENT_ID, fakeData } from "./fakes.ts";

const OTHER_ID = "99999999-9999-4999-8999-999999999999";
const shipmentResult: ToolResult = {
  rows: [
    { subject: "Поставка NAR-2026-0007", values: { shipment_number: "NAR-2026-0007", shipment_status: "В пути", planned_arrival_date: "2026-10-05" }, entity: { type: "shipment", id: SHIPMENT_ID } },
    { subject: "Поставка NAR-2026-0008", values: { shipment_number: "NAR-2026-0008", shipment_status: "Закрыта" }, entity: { type: "shipment", id: OTHER_ID } },
  ],
  truncated: true,
  total: 3,
  notes: [],
};
const calls = new Map<string, CallRecord>([["c1", { tool: TOOL_BY_NAME.get("find_shipments")!, result: shipmentResult }]]);
type Fact = { call: string; row: number; fields: string[] };
type Note = { kind: "assumption" | "explanation"; text: string };
const answer = (facts: Fact[], commentary: Note[] = [], limitations: string[] = [], records = calls) => {
  const raw = parseAnswer(JSON.stringify({ facts, commentary, limitations }));
  assert.ok(raw, "answer JSON must be valid");
  return verifyAnswer(raw, records);
};

async function vehicleCalls(): Promise<Map<string, CallRecord>> {
  const tool = TOOL_BY_NAME.get("get_shipment_vehicles")!;
  const result = await tool.run({ userId: "u", data: fakeData(), signal: new AbortController().signal }, { shipment_id: SHIPMENT_ID });
  return new Map([["v1", { tool, result }]]);
}

describe("assistant verified facts", () => {
  it("builds the statement by code from the row subject and the selected fields", () => {
    const result = answer([{ call: "c1", row: 0, fields: ["shipment_status", "planned_arrival_date"] }]);
    assert.equal(result.facts.length, 1);
    const fact = result.facts[0];
    assert.equal(fact.subject, "Поставка NAR-2026-0007");
    assert.deepEqual(fact.values.map((value) => [value.label, value.value]), [["Статус поставки", "В пути"], ["Плановое прибытие", "05.10.2026"]]);
    assert.deepEqual(fact.source, { tool: "find_shipments", row: 0 });
    assert.equal(fact.link?.href, `/shipments/${SHIPMENT_ID}`);
    assert.deepEqual(result.rejected, []);
  });

  it("reproduction: a planned arrival date cannot become a verified «arrived without damage» statement", async () => {
    const result = answer(
      [{ call: "v1", row: 0, fields: ["planned_arrival_date"] }],
      [{ kind: "explanation", text: "Машина прибыла 05.10.2026 без повреждений." }],
      [],
      await vehicleCalls(),
    );
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0].subject, "Поставка NAR-2026-0007 · автомобиль № 1");
    assert.deepEqual(result.facts[0].values.map((value) => `${value.label}: ${value.value}`), ["Плановое прибытие: 05.10.2026"]);
    // The model's claim stays its own unverified text and is never part of a verified fact.
    assert.ok(!JSON.stringify(result.facts).includes("прибыла") && !JSON.stringify(result.facts).includes("повреждений"));
    assert.deepEqual(result.commentary, [{ kind: "explanation", text: "Машина прибыла 05.10.2026 без повреждений." }]);
  });

  it("refuses a wrong field: an empty actual date, a field of another tool or an unknown field", async () => {
    const vehicles = await vehicleCalls();
    const actual = answer([{ call: "v1", row: 0, fields: ["actual_arrival_date"] }], [], [], vehicles);
    assert.equal(actual.facts.length, 0, "actual arrival is empty, so nothing is confirmed");
    assert.match(actual.rejected[0], /нет значения «Фактическое прибытие»/);
    const foreign = answer([{ call: "c1", row: 0, fields: ["vehicle_plate", "unit_price"] }]);
    assert.equal(foreign.facts.length, 0);
    assert.equal(foreign.rejected.length, 2);
    const mixed = answer([{ call: "c1", row: 0, fields: ["shipment_status", "unit_price"] }]);
    assert.deepEqual(mixed.facts[0].values.map((value) => value.field), ["shipment_status"], "only the existing field is shown");
    assert.equal(mixed.rejected.length, 1);
  });

  it("refuses another object: a missing row or call, and never attaches values to a different subject", () => {
    assert.equal(answer([{ call: "c1", row: 5, fields: ["shipment_number"] }]).facts.length, 0);
    assert.equal(answer([{ call: "c1", row: -1, fields: ["shipment_number"] }]).facts.length, 0);
    assert.equal(answer([{ call: "c9", row: 0, fields: ["shipment_number"] }]).facts.length, 0);
    const second = answer([{ call: "c1", row: 1, fields: ["shipment_status"] }], [{ kind: "explanation", text: "Поставка NAR-2026-0007 закрыта." }]);
    assert.equal(second.facts[0].subject, "Поставка NAR-2026-0008", "the status belongs to the object of row 1, whatever the text says");
    assert.equal(second.facts[0].link?.href, `/shipments/${OTHER_ID}`);
    assert.equal(second.commentary[0].text, "Поставка NAR-2026-0007 закрыта.");
  });

  it("shows an unconfirmed statement only as commentary, never as a fact", () => {
    const result = answer([], [{ kind: "assumption", text: "Поставка доставлена, задержек нет." }]);
    assert.equal(result.facts.length, 0);
    assert.deepEqual(result.commentary, [{ kind: "assumption", text: "Поставка доставлена, задержек нет." }]);
    assert.ok(result.limitations.includes("Проверенных данных Nexus в ответе нет."));
  });

  it("verifies counts against the result itself", () => {
    const result = answer([{ call: "c1", row: 0, fields: ["$count", "$total"] }]);
    assert.deepEqual(result.facts[0].values.map((value) => [value.label, value.value]), [["Показано записей", "2"], ["Всего записей", "3"]]);
    assert.equal(result.facts[0].source.row, -1);
    const mixed = answer([{ call: "c1", row: 0, fields: ["$count", "shipment_status"] }]);
    assert.equal(mixed.facts[0].values.length, 1);
    assert.equal(mixed.rejected.length, 1);
  });

  it("does not let a truncated result be described as complete", () => {
    assert.ok(answer([]).limitations.some((item) => item.includes("показаны не все записи (2 из 3)")));
  });

  it("strips URLs and masks personal data in commentary", () => {
    const result = answer([], [{ kind: "assumption", text: "Возможно, задержка из-за таможни, см. https://evil.example/x и [тут](https://evil.example). ИИН 900101300123" }]);
    assert.doesNotMatch(result.commentary[0].text, /evil\.example|https?:|900101300123/);
  });

  it("rejects malformed or extended answer JSON, including the old free-text fact format", () => {
    assert.equal(parseAnswer("not json"), null);
    assert.equal(parseAnswer(JSON.stringify({ facts: [], commentary: [], limitations: [], html: "<script>" })), null);
    assert.equal(parseAnswer(JSON.stringify({ facts: [{ call: "c1", row: 0, fields: ["shipment_number"], text: "Прибыла" }], commentary: [], limitations: [] })), null);
    assert.equal(parseAnswer(JSON.stringify({ facts: [{ call: "c1", row: 0, fields: [] }], commentary: [], limitations: [] })), null);
    assert.equal(parseAnswer(JSON.stringify({ facts: [], commentary: [{ kind: "fact", text: "x" }], limitations: [] })), null);
    assert.equal(parseAnswer(JSON.stringify({ blocks: [{ kind: "fact", text: "x", refs: [] }], limitations: [] })), null);
    assert.ok(JSON.stringify(ANSWER_JSON_SCHEMA).includes("\"fields\""));
  });

  it("drops model limitations that smuggle unverified numbers but keeps server notes", () => {
    const result = answer([], [], ["Поставка прибудет 09.10.2026", "Нет прав на документы"]);
    assert.ok(!result.limitations.some((item) => item.includes("09.10.2026")));
    assert.ok(result.limitations.includes("Нет прав на документы"));
  });
});
