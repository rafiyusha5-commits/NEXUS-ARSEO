import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOpeningRows, parseCsv, parseOpeningBalances } from "../../src/lib/finance/opening-balances.ts";

describe("opening balances from the 1С report", () => {
  it("chooses the signed closing balance instead of the opening balance", () => {
    assert.equal(parseOpeningBalances([["Контрагент", "Сальдо на начало", "Сальдо на конец"], ["А", 100, 250]]).rows[0].amount, 250);
    assert.equal(parseOpeningBalances([["Контрагент", "Остаток на конец", "Остаток на начало"], ["А", -25, 100]]).rows[0].amount, -25);
  });
  it("rejects ambiguous signed balances and opening-only reports", () => {
    for (const headers of [["Сальдо", "Остаток"], ["Сальдо на конец", "Остаток на конец"], ["Сальдо на начало"]]) {
      assert.throws(() => parseOpeningBalances([["Контрагент", ...headers], ["А", 100, 250]]), /остаток|остатки|колонки/);
    }
  });
  it("takes the closing debit minus credit when the report has several pairs", () => {
    // Period labels are merged cells above «Дебет»/«Кредит»; «Контрагент» is in the same row as the pairs.
    const parsed = parseOpeningBalances([
      ["Ведомость по взаиморасчётам с контрагентами", null, null, null, null, null, null, null],
      ["Период: 01.01.2026 - 30.09.2026", null, null, null, null, null, null, null],
      ["", "", "", "Сальдо на начало периода", "", "Сальдо на конец периода", "", ""],
      ["Контрагент", "БИН", "Договор", "Дебет", "Кредит", "Дебет", "Кредит", "Валюта"],
      ["ТОО «Альфа»", "1234 5678 9012", "Д-1", 100, 0, "1 500,00", null, "KZT"],
      ["ТОО «Бета»", null, "Д-7", 0, 0, 0, 250.5, "тг"],
      ["ИП Гамма", "870101300123", null, 0, 0, "abc", 0, null],
      ["Итого", null, null, 100, 0, 1500, 250.5, null],
    ]);
    assert.deepEqual(parsed.rows, [
      { rowNumber: 5, name: "ТОО «Альфа»", bin: "123456789012", contract: "Д-1", currency: "KZT", amount: 1500, due_date: null },
      { rowNumber: 6, name: "ТОО «Бета»", bin: null, contract: "Д-7", currency: "KZT", amount: -250.5, due_date: null },
    ]);
    assert.deepEqual(parsed.problems, ["Строка 7: сумма не распознана"]);
  });

  it("reads «Дебет»/«Кредит» from the row below «Контрагент»", () => {
    const parsed = parseOpeningBalances([
      ["Контрагент", "Сальдо на конец периода", "", "Обороты за период", ""],
      ["", "Дебет", "Кредит", "Дебет", "Кредит"],
      ["ТОО «Альфа»", 900, 100, 5, 5],
    ]);
    assert.deepEqual(parsed.rows.map(row => [row.rowNumber, row.name, row.amount]), [[3, "ТОО «Альфа»", 800]]);
  });

  it("takes a single signed balance column and a due date", () => {
    const parsed = parseOpeningBalances(parseCsv("Покупатель;ИИН/БИН;Сальдо;Срок оплаты;Валюта\n\"ТОО \"\"Дельта\"\"\";123;-10,5;15.10.2026;EUR\n"));
    assert.deepEqual(parsed.rows, [{ rowNumber: 2, name: "ТОО \"Дельта\"", bin: "123", contract: null, currency: "EUR", amount: -10.5, due_date: "2026-10-15" }]);
  });

  it("without an end-of-period label refuses to guess the last pair", () => {
    assert.throws(() => parseOpeningBalances([["Контрагент", "Дебет", "Кредит", "Дебет", "Кредит"], ["А", 5, 0, 7, 2]]), /Неоднозначные/);
  });

  it("refuses a file without the needed columns", () => {
    assert.throws(() => parseOpeningBalances([["Товар", "Сумма"], ["x", 1]]), /Контрагент/);
    assert.throws(() => parseOpeningBalances([["Контрагент", "Комментарий"], ["x", 1]]), /Сальдо/);
  });

  it("re-checks what the browser sends", () => {
    assert.deepEqual(normalizeOpeningRows([{ name: " А ", amount: 1.005, currency: "KZT", due_date: "x" }]),
      [{ name: "А", bin: null, contract: null, currency: "KZT", amount: 1, due_date: null }]);
    assert.throws(() => normalizeOpeningRows([{ name: "А", amount: "1", currency: "KZT" }]), /Строка 1/);
    assert.throws(() => normalizeOpeningRows([]), /нет строк/);
  });
});

describe("CSV", () => {
  it("detects the separator", () => {
    assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(parseCsv("a\tb\n1,5\t2"), [["a", "b"], ["1,5", "2"]]);
    assert.deepEqual(parseCsv("a;b\r\n\"x;y\";2,5\r\n\r\n"), [["a", "b"], ["x;y", "2,5"]]);
  });
});
