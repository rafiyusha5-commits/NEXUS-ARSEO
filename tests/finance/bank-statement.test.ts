import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeStatement, normalizeBankPayments, parseBankStatement, parseStatementAmount, parseStatementDate } from "../../src/lib/finance/bank-statement.ts";

// A synthetic statement in the 1С exchange format; names and numbers are made up.
const OUR = "KZ00 551F 0000 0000 0001";
const statement = [
  "1CClientBankExchange", "ВерсияФормата=1.02", "Кодировка=Windows", "Отправитель=Банк",
  "ДатаНачала=01.09.2026", "ДатаКонца=30.09.2026", `РасчСчет=${OUR}`,
  "СекцияРасчСчет", "ДатаНачала=01.09.2026", `РасчСчет=${OUR}`, "НачальныйОстаток=100.00", "КонецРасчСчет",
  "СекцияДокумент=Платежное поручение", "Номер=15", "Дата=04.09.2026", "Сумма=150 000,50",
  "ПлательщикИИК=KZ11 0000 0000 0000 0002", "Плательщик=ТОО «Покупатель»", "ПлательщикБИН=1234 5678 9012",
  "ПолучательИИК=KZ00551F000000000001", "ДатаПоступило=05.09.2026",
  "НазначениеПлатежа=Оплата по счёту SO-2026-000123", "НазначениеПлатежа1=  без НДС ", "КонецДокумента",
  "СекцияДокумент=Платежное поручение", "Номер=16", "Дата=06.09.2026", "Сумма=9000",
  `ПлательщикСчет=${OUR}`, "Плательщик=Наша компания", "ПолучательСчет=KZ99000000000000000009", "ДатаСписано=06.09.2026",
  "НазначениеПлатежа=Оплата перевозчику", "КонецДокумента",
  "СекцияДокумент=Платежное поручение", "Номер=17", "Дата=31.02.2026", "Сумма=10",
  "ПлательщикИИН=870101300123", "ПолучательРасчСчет=KZ00551F000000000001", "КонецДокумента",
  "КонецФайла",
].join("\r\n");

describe("1С bank statement", () => {
  it("keeps incoming payments to our accounts with the payer and the purpose", () => {
    const parsed = parseBankStatement(statement);
    assert.deepEqual(parsed.accounts, ["KZ00551F000000000001"]);
    assert.equal(parsed.periodFrom, "2026-09-01");
    assert.equal(parsed.periodTo, "2026-09-30");
    assert.equal(parsed.documents, 3);
    assert.equal(parsed.outgoing, 1);
    assert.deepEqual(parsed.incoming, [{
      doc_number: "15", doc_date: "2026-09-05", amount: 150000.5, payer_name: "ТОО «Покупатель»", payer_bin: "123456789012",
      payer_account: "KZ110000000000000002", purpose: "Оплата по счёту SO-2026-000123 без НДС",
    }]);
    assert.deepEqual(parsed.problems, ["Документ 3 (№ 17): нет даты или дата некорректна"]);
  });

  it("without our accounts in the header, takes documents with a receipt date and no debit date", () => {
    const parsed = parseBankStatement(statement.split("\r\n").filter(line => !line.startsWith("РасчСчет=")).join("\n"));
    assert.equal(parsed.incoming.length, 1);
    assert.equal(parsed.outgoing, 2);
  });

  it("reads Windows-1251 and UTF-8 files", () => {
    const cp1251 = new Uint8Array([0x31, 0x43, 0x0a, 0xcf, 0xeb, 0xe0, 0xf2, 0xe5, 0xe6]); // "1C\nПлатеж"
    assert.equal(decodeStatement(cp1251), "1C\nПлатеж");
    const utf8 = new TextEncoder().encode("﻿Платёж");
    assert.equal(decodeStatement(utf8), "Платёж");
  });

  it("refuses other files and broken documents", () => {
    assert.throws(() => parseBankStatement("Дата;Сумма\n01.01.2026;5"), /не выписка в формате 1С/);
    assert.throws(() => parseBankStatement("1CClientBankExchange\nСекцияДокумент=П\nСумма=5"), /оборван/);
  });

  it("parses dates and amounts strictly", () => {
    assert.equal(parseStatementDate("29.02.2028"), "2028-02-29");
    assert.equal(parseStatementDate("29.02.2026"), null);
    assert.equal(parseStatementDate("2026-09-01"), null);
    assert.equal(parseStatementAmount("1 234,56"), 1234.56);
    assert.equal(parseStatementAmount("1.234,56"), null);
    assert.equal(parseStatementAmount("10.001"), null);
    assert.equal(parseStatementAmount(10.5), 10.5);
  });

  it("re-checks what the browser sends", () => {
    assert.deepEqual(normalizeBankPayments([{ doc_date: "2026-09-05", amount: 5, payer_bin: "12-34", purpose: " x " }]),
      [{ doc_number: null, doc_date: "2026-09-05", amount: 5, payer_name: null, payer_bin: "1234", payer_account: null, purpose: "x" }]);
    assert.throws(() => normalizeBankPayments([{ doc_date: "05.09.2026", amount: 5 }]), /Платёж 1/);
    assert.throws(() => normalizeBankPayments([{ doc_date: "2026-09-05", amount: "5" }]), /Платёж 1/);
    assert.throws(() => normalizeBankPayments([{ doc_date: "2026-09-05", amount: -5 }]), /Платёж 1/);
    assert.throws(() => normalizeBankPayments("[]"), /Некорректный/);
  });
});
