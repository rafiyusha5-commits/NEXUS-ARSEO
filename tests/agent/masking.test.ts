import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskDataText, maskFactText, maskOutgoing, maskSensitive, prepareQuestion, traceExcerpt } from "../../src/lib/agent/masking.ts";

describe("assistant masking", () => {
  it("masks identity documents, IIN, passports and phones in the question", () => {
    const { text, masked } = maskSensitive("Водитель: удостоверение № 045678912, ИИН 900101300123, паспорт N12345678, тел. +7 701 555 44 33");
    assert.doesNotMatch(text, /045678912|900101300123|12345678|555 44 33/);
    assert.ok(masked >= 4);
  });

  it("masks a bare 9-digit ID card number and a 12-digit IIN without keywords", () => {
    assert.doesNotMatch(maskSensitive("номер 045678912").text, /045678912/);
    assert.doesNotMatch(maskSensitive("клиент 900101300123").text, /900101300123/);
  });

  it("masks document numbers and IIN written with spaces or hyphens", () => {
    for (const value of ["045 678 912", "045-678-912", "900101 300123", "900 101 300 123"]) {
      assert.doesNotMatch(maskSensitive(`номер ${value}`).text, new RegExp(value.replace(/ /g, "\\s")), value);
    }
  });

  it("keeps ordinary logistics identifiers", () => {
    const text = maskSensitive("Поставка NAR-2026-0007, автомобиль 123ABC02, 18 паллет").text;
    assert.match(text, /NAR-2026-0007/);
    assert.match(text, /123ABC02/);
    assert.match(text, /18 паллет/);
  });

  it("masks secrets: API keys, bearer tokens, JWT, passwords, connection strings and private keys", () => {
    const input = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "Authorization: Bearer abcdefghijklmnop.qrstuv",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlc2ln",
      "password=SuperSecret1",
      "postgres://admin:hunter2@db.example.com/nexus",
      "AIzaSyA1234567890abcdefghijklmnopq",
    ].join("\n");
    const { text } = maskSensitive(input);
    for (const secret of ["abcdefghijklmnopqrstuvwxyz123456", "abcdefghijklmnop.qrstuv", "eyJhbGci", "SuperSecret1", "hunter2", "AIzaSyA1234567890"]) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
  });

  it("removes invisible characters that can hide instructions", () => {
    assert.equal(maskSensitive("а\u200Bб\u202Eв").text, "абв");
  });

  it("masks money in Nexus free text and withholds text with unknown long numbers", () => {
    assert.doesNotMatch(maskDataText("Ждём оплату 15 000 EUR и 2 500,50 ₸") ?? "", /15 000|2 500/);
    assert.doesNotMatch(maskDataText("Связаться 77015554433012") ?? "", /\d{4}/);
    assert.equal(maskDataText("Связаться 0456.78912"), "[текст скрыт: возможны персональные данные]");
    assert.equal(maskDataText("Ждём до 05.10.2026"), "Ждём до 05.10.2026");
    assert.equal(maskDataText(""), null);
    assert.equal(maskDataText("слово ".repeat(60), 50)?.length, 50);
  });

  it("refuses questions that cannot be cleaned safely and never returns the raw text", () => {
    assert.deepEqual(prepareQuestion("   "), { ok: false, code: "QUESTION_EMPTY" });
    assert.deepEqual(prepareQuestion("x".repeat(1001)), { ok: false, code: "QUESTION_TOO_LONG" });
    assert.deepEqual(prepareQuestion("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"), { ok: false, code: "QUESTION_UNSAFE" });
    assert.deepEqual(prepareQuestion("045678912 045678913 045678914 045678915 045678916 045678917"), { ok: false, code: "QUESTION_UNSAFE" });
    const ok = prepareQuestion("Где водитель с удостоверением 045678912?");
    assert.ok(ok.ok && !ok.text.includes("045678912"));
  });

  it("masks a number split by spaces or hyphens in any grouping and refuses forms it cannot clean", () => {
    for (const value of ["0456 78912", "0456-78912", "04 56 78 912", "0456 - 78912", "0456\u2013789 12", "0456\u00a078912", "045678912345", "\uff10\uff14\uff15\uff16 78912"]) {
      const result = prepareQuestion(`Проверь номер ${value}`);
      assert.ok(result.ok, value);
      assert.ok(result.ok && !/\d/.test(result.text) && result.masked >= 1, `${value} -> ${result.ok ? result.text : ""}`);
    }
    for (const value of ["0456.78912", "0456_78912", "0456/78912", "(0456) 789.12"]) {
      assert.deepEqual(prepareQuestion(`Проверь номер ${value}`), { ok: false, code: "QUESTION_UNSAFE" }, value);
    }
  });

  it("keeps ordinary shipment numbers, plates, dates and quantities in the question", () => {
    const question = "Где поставка NAR-2026-0007 и машина 123ABC02 (прицеп 45AB02)? План 05.10.2026 12:30, 18 паллет, 2026 год";
    assert.deepEqual(prepareQuestion(question), { ok: true, text: question, masked: 0 });
  });

  it("keeps record identifiers (UUID) intact, including all-digit groups", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(maskSensitive(`/shipments/${id}`).text, `/shipments/${id}`);
    assert.deepEqual(prepareQuestion(`Что с ${id}?`), { ok: true, text: `Что с ${id}?`, masked: 0 });
    assert.equal(maskOutgoing(JSON.stringify({ shipment_id: id, query: "0456.78912" })), JSON.stringify({ shipment_id: id, query: "[скрыто]" }));
  });

  it("keeps Nexus identifiers readable in code-built facts while masking personal numbers and money", () => {
    assert.equal(maskFactText("Поставка NAR-2026-0007 · автомобиль № 1"), "Поставка NAR-2026-0007 · автомобиль № 1");
    assert.equal(maskFactText("Плановое прибытие: 05.10.2026"), "Плановое прибытие: 05.10.2026");
    assert.doesNotMatch(maskFactText("Водитель ИИН 900101300123, тел. +7 701 555 44 33, номер 0456 78912"), /900101300123|555 44 33|78912/);
    assert.doesNotMatch(maskFactText("Сумма: 15 000 EUR"), /15 000/);
    assert.equal(maskDataText("Поставка NAR-2026-0007"), "[текст скрыт: возможны персональные данные]", "free text keeps the strict rule");
  });

  it("keeps the trace excerpt short", () => {
    assert.ok(traceExcerpt("слово ".repeat(100)).length <= 120);
  });
});
