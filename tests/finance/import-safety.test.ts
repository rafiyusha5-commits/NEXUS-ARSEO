import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOpeningBalances, parseCsv } from "../../src/lib/finance/opening-balances.ts";
import { decodeStatement, parseBankStatement } from "../../src/lib/finance/bank-statement.ts";

test("ambiguous parent and contract totals cannot be imported together", () => {
  const result = parseOpeningBalances([
    ["Контрагент", "БИН", "Договор", "Сальдо"],
    ["Синтетический покупатель", "990000000001", "", 100],
    ["Синтетический покупатель", "990000000001", "Д-1", 100],
  ]);
  assert.ok(result.problems.length > 0);
});
test("an unnamed contract is an error, not a silently discarded row", () => {
  const result = parseOpeningBalances([["Контрагент", "Договор", "Сальдо"], ["", "Д-1", 100]]);
  assert.ok(result.problems.length > 0);
});
test("several unlabelled debit pairs are not guessed", () => {
  assert.throws(() => parseOpeningBalances([["Контрагент", "Дебет", "Кредит", "Дебет", "Кредит"], ["А", 1, 0, 2, 0]]));
});
test("broken CSV quoting is not accepted", () => assert.throws(() => parseCsv('Контрагент;Сальдо\n"А;100')));
test("a bare exchange marker is not an empty valid statement", () => assert.throws(() => parseBankStatement("1CClientBankExchange")));
test("synthetic files, Cyrillic and decimal separators", () => {
  const file = (name: string) => readFileSync(new URL(`../fixtures/finance/${name}`,import.meta.url),"utf8");
  assert.equal(parseOpeningBalances(parseCsv(file("opening-flat.csv"))).rows[0].amount,1234.56);
  assert.ok(parseOpeningBalances(parseCsv(file("opening-hierarchy.csv"))).problems.length>0);
  const parsed = parseBankStatement(file("bank-utf8.txt"));
  assert.equal(parsed.incoming[0].operation_id,"SYNTH-001");
  assert.equal(parsed.incoming[0].amount,1234.56);
  // Deterministic Windows-1251 bytes; no real company file is used.
  const cp = Uint8Array.from([..."Контрагент;Сальдо\nА;100"].map(ch => ch.charCodeAt(0)>=0x410 ? ch.charCodeAt(0)-0x410+0xc0 : ch.charCodeAt(0)));
  assert.equal(parseOpeningBalances(parseCsv(decodeStatement(cp))).rows[0].amount,100);
  assert.ok(parseBankStatement(file("bank-utf8.txt").replace("Номер=1","Валюта=USD\nНомер=1")).problems.length>0);
});
