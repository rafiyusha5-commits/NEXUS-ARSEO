import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskDataText, maskSensitive, prepareQuestion, traceExcerpt } from "../../src/lib/agent/masking.ts";

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
    assert.equal(maskDataText("Связаться 77015554433012"), "[текст скрыт: возможны персональные данные]");
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

  it("keeps the trace excerpt short", () => {
    assert.ok(traceExcerpt("слово ".repeat(100)).length <= 120);
  });
});
