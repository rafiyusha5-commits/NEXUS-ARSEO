import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnswer, verifyAnswer, type CallRecord } from "../../src/lib/agent/facts.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import type { ToolResult } from "../../src/lib/agent/types.ts";
import { SHIPMENT_ID } from "./fakes.ts";

const shipmentResult: ToolResult = {
  rows: [{ values: { shipment_number: "NAR-2026-0007", shipment_status: "В пути", planned_arrival_date: "2026-10-05" }, entity: { type: "shipment", id: SHIPMENT_ID } }],
  truncated: true,
  total: 3,
  notes: [],
};
const calls = new Map<string, CallRecord>([["c1", { tool: TOOL_BY_NAME.get("find_shipments")!, result: shipmentResult }]]);
const answer = (blocks: unknown[], limitations: string[] = []) => verifyAnswer(parseAnswer(JSON.stringify({ blocks, limitations }))!, calls);

describe("assistant fact checking", () => {
  it("accepts a fact whose numbers, dates and statuses match referenced fields and renders values by code", () => {
    const result = answer([{ kind: "fact", text: "Поставка NAR-2026-0007 в статусе «В пути», плановое прибытие 05.10.2026.", refs: [
      { call: "c1", row: 0, field: "shipment_number" }, { call: "c1", row: 0, field: "shipment_status" }, { call: "c1", row: 0, field: "planned_arrival_date" },
    ] }]);
    const block = result.blocks[0];
    assert.equal(block.kind, "fact");
    assert.ok(block.kind === "fact" && block.values.some((value) => value.label === "Плановое прибытие" && value.value === "05.10.2026"));
    assert.ok(block.kind === "fact" && block.links[0].href === `/shipments/${SHIPMENT_ID}`);
  });

  it("downgrades a fact with a number that is not in the referenced data", () => {
    const block = answer([{ kind: "fact", text: "Плановое прибытие 07.10.2026.", refs: [{ call: "c1", row: 0, field: "planned_arrival_date" }] }]).blocks[0];
    assert.equal(block.kind, "unverified");
  });

  it("does not mark a fact without references, with a missing call or a missing field as FACT", () => {
    assert.equal(answer([{ kind: "fact", text: "Поставок три.", refs: [] }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "NAR-2026-0007", refs: [{ call: "c9", row: 0, field: "shipment_number" }] }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "NAR-2026-0007", refs: [{ call: "c1", row: 5, field: "shipment_number" }] }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "NAR-2026-0007", refs: [{ call: "c1", row: 0, field: "unit_price" }] }]).blocks[0].kind, "unverified");
  });

  it("rejects a status word that the referenced data does not confirm", () => {
    const block = answer([{ kind: "fact", text: "Поставка NAR-2026-0007 закрыта: Закрыта.", refs: [{ call: "c1", row: 0, field: "shipment_number" }, { call: "c1", row: 0, field: "shipment_status" }] }]).blocks[0];
    assert.equal(block.kind, "unverified");
  });

  it("does not let a truncated result be described as complete", () => {
    const block = answer([{ kind: "fact", text: "Это все задержанные поставки: NAR-2026-0007.", refs: [{ call: "c1", row: 0, field: "shipment_number" }] }]).blocks[0];
    assert.equal(block.kind, "unverified");
    const limitations = answer([]).limitations;
    assert.ok(limitations.some((item) => item.includes("показаны не все записи (1 из 3)")));
  });

  it("verifies counts against $count and $total", () => {
    assert.equal(answer([{ kind: "fact", text: "Всего задержано 3 поставки.", refs: [{ call: "c1", row: 0, field: "$total" }] }]).blocks[0].kind, "unverified", "completeness word on a truncated result");
    assert.equal(answer([{ kind: "fact", text: "Найдено 3 поставки.", refs: [{ call: "c1", row: 0, field: "$total" }] }]).blocks[0].kind, "fact");
    assert.equal(answer([{ kind: "fact", text: "Показана 1 поставка.", refs: [{ call: "c1", row: 0, field: "$count" }] }]).blocks[0].kind, "fact");
  });

  it("labels assumptions and strips URLs proposed by the model", () => {
    const result = answer([{ kind: "assumption", text: "Возможно, задержка из-за таможни, см. https://evil.example/x и [тут](https://evil.example)", refs: [] }]);
    assert.equal(result.blocks[0].kind, "assumption");
    assert.doesNotMatch(result.blocks[0].text, /evil\.example|https?:/);
  });

  it("rejects malformed or extended answer JSON", () => {
    assert.equal(parseAnswer("not json"), null);
    assert.equal(parseAnswer(JSON.stringify({ blocks: [], limitations: [], html: "<script>" })), null);
    assert.equal(parseAnswer(JSON.stringify({ blocks: [{ kind: "fact", text: "x", refs: [], url: "x" }], limitations: [] })), null);
    assert.equal(parseAnswer(JSON.stringify({ blocks: [{ kind: "command", text: "x", refs: [] }], limitations: [] })), null);
  });

  it("does not accept parts of a referenced value as confirmation of an invented number", () => {
    const date = [{ call: "c1", row: 0, field: "planned_arrival_date" }];
    const id = [{ call: "c1", row: 0, field: "shipment_number" }];
    assert.equal(answer([{ kind: "fact", text: "Задержка 5 дней.", refs: date }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "Ожидается 10 машин.", refs: date }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "Поставок в 2026 году много.", refs: date }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "Позиция 0007 готова.", refs: id }]).blocks[0].kind, "unverified");
  });

  it("does not accept quantities or dates written in words", () => {
    const refs = [{ call: "c1", row: 0, field: "shipment_number" }];
    assert.equal(answer([{ kind: "fact", text: "NAR-2026-0007 опаздывает на пять дней.", refs }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "По NAR-2026-0007 две машины.", refs }]).blocks[0].kind, "unverified");
  });

  it("accepts a date written with a month name only when it equals the referenced date", () => {
    const refs = [{ call: "c1", row: 0, field: "planned_arrival_date" }];
    assert.equal(answer([{ kind: "fact", text: "Плановое прибытие 5 октября 2026 года.", refs }]).blocks[0].kind, "fact");
    assert.equal(answer([{ kind: "fact", text: "Плановое прибытие 6 октября 2026 года.", refs }]).blocks[0].kind, "unverified");
  });

  it("does not accept a state that the referenced status does not confirm", () => {
    const status = [{ call: "c1", row: 0, field: "shipment_number" }, { call: "c1", row: 0, field: "shipment_status" }];
    assert.equal(answer([{ kind: "fact", text: "Поставка NAR-2026-0007 доставлена.", refs: status }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "Поставка NAR-2026-0007 задерживается.", refs: status }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "Поставка NAR-2026-0007 отменена.", refs: status }]).blocks[0].kind, "unverified");
    assert.equal(answer([{ kind: "fact", text: "Поставка NAR-2026-0007 сейчас в пути.", refs: status }]).blocks[0].kind, "fact");
  });

  it("does not let a planned date be presented as the actual one", () => {
    const refs = [{ call: "c1", row: 0, field: "planned_arrival_date" }];
    assert.equal(answer([{ kind: "fact", text: "Фактически машина прибыла 05.10.2026.", refs }]).blocks[0].kind, "unverified");
  });

  it("drops model limitations that smuggle unverified numbers but keeps server notes", () => {
    const result = answer([], ["Поставка прибудет 09.10.2026", "Нет прав на документы"]);
    assert.ok(!result.limitations.some((item) => item.includes("09.10.2026")));
    assert.ok(result.limitations.includes("Нет прав на документы"));
  });

  it("returns an explicit unverified block when the model gives nothing", () => {
    assert.equal(answer([]).blocks[0].kind, "unverified");
  });
});
