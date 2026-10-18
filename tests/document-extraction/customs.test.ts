import assert from "node:assert/strict";
import { test } from "node:test";
import { customsAmount, customsLayout, parseCustomsForm } from "../../src/lib/document-extraction/customs.ts";
import { extractShipmentFields, sanitizeConfirmedSourceData } from "../../src/lib/document-extraction/rules.ts";

const declaration = `ДЕКЛАРАЦИЯ НА ТОВАРЫ
No | 50123/041126/0000123
12 ОБЩАЯ ТАМОЖЕННАЯ СТОИМОСТЬ | 13 C.A.P
посл отп
PL | 120000,50
22 Валюта и общая сумма по счету | 23 Курс валюты | 24 Характер
BY | EUR | 200,00 | 550,25 | 021
31 Грузовые
45 Таможенная стоимость
99999,99\fДЕКЛАРАЦИЯ НА ТОВАРЫ\nPL | 88888,88`;
const assessment = `Assessment Notice
Customs office: | 50123 - Office
ИМ 40 | 04/11/2026 D 123 | 2026 #20 | 04/11/2026 K 456 | 10
Item taxes
Tax code | Tax description | Tax value
1010 | Сбор | 10,00
2010 | Пошлина | 1.000,25
5060 | НДС | 100,50
1.110,75
Total Item taxes
1.110,75
Total assessed amount for the declaration
0,00`;
const field = (text: string, label: string) => parseCustomsForm(text)?.fields.find(f => f.label === label)?.value.replace(/\s/g, "");
test("declaration uses registration date and header total, not item totals or later pages", () => {
  assert.equal(field(declaration,"Номер декларации"),"50123/041126/0000123");
  assert.equal(field(declaration,"Дата регистрации (из номера ДТ)"),"2026-11-04");
  assert.equal(field(declaration,"Общая таможенная стоимость (гр. 12)"),"120000,50");
  assert.equal(field(declaration,"Курс валюты (гр. 23)"),"550,25");
  assert.equal(field(declaration.replace("PL | 120000,50", ""),"Общая таможенная стоимость (гр. 12)"),undefined);
});
test("assessment reads each tax once and validates sum independently of repeated printed total", () => {
  assert.equal(field(assessment,"Номер расчёта"),"K456");
  assert.equal(field(assessment,"Всего начислено по декларации"),"1110,75");
  assert.equal(field(assessment,"Ввозная пошлина · 2010"),"1000,25");
  assert.ok(field(assessment,"Проверка суммы строк"));
});
test("unknown codes participate in reconciliation; mismatch, missing and duplicate rows require review", () => {
  for (const text of [assessment.replace('100,50','101,50'), assessment.replace('2010 | Пошлина | 1.000,25',''), assessment+'\n1010 | Сбор | 10,00', assessment.replace('1.000,25','unread')]) {
    assert.equal(field(text,"Проверка суммы строк"),undefined);
    assert.ok(parseCustomsForm(text)?.warnings.some(w=>w.includes('Итог начислений не подтверждён')));
  }
  assert.ok(field(assessment.replace('5060','9999'),"Проверка суммы строк"));
});
test("only valid localized amounts and dates are accepted", () => {
  assert.equal(customsAmount('1.234.567,89'),1234567.89);
  for (const v of ['1.23,45','12,3','NaN','-1,00','Infinity','1,2,3']) assert.equal(customsAmount(v),null);
  assert.equal(field(declaration.replace('041126','321126'),"Дата регистрации (из номера ДТ)"),undefined);
});
test("customs evidence is read-only and cannot be submitted as shipment fields", () => {
  const result = extractShipmentFields(declaration);
  assert.deepEqual(Object.keys(result.data),['customs_record']);
  assert.deepEqual(sanitizeConfirmedSourceData(result.data),{});
  assert.equal(parseCustomsForm('Invoice 123'),null);
  assert.equal(parseCustomsForm('Assessment Notice')?.fields.length,0);
});
test("PDF columns are ordered geometrically with page-local rows", () => {
  const item=(str:string,x:number,y:number)=>({str,transform:[1,0,0,1,x,y]});
  assert.equal(customsLayout([item('100,00',40,100),item('1010',0,100),item('header',0,120)]),'header\n1010 | 100,00');
});
