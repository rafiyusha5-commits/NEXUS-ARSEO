import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import PizZip from "pizzip";
import { XlsxWorkbook } from "../../src/lib/export-workbook/xlsx-package.ts";
import { fillExportWorkbook, TemplateLayoutError } from "../../src/lib/export-workbook/fill.ts";
import { buildExportDocuments, extractSheetWorkbook, OUTPUT_SHEETS, PreflightError } from "../../src/lib/export-workbook/index.ts";
import { buildExportModel } from "../../src/lib/export-workbook/model.ts";
import { preflightExport } from "../../src/lib/export-workbook/preflight.ts";
import { renderSheetHtml } from "../../src/lib/export-workbook/preview.ts";
import { baseData, fixtureBytes, makeItems } from "./helpers.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fill = (data: Record<string, unknown>) => fillExportWorkbook(fixtureBytes(), buildExportModel(data));
const reload = (workbook: XlsxWorkbook) => XlsxWorkbook.load(workbook.toBytes());
const formulasOf = (workbook: XlsxWorkbook) => workbook.sheets.flatMap(sheet => [...sheet.formulaCells()].map(({ f, ref }) => ({ sheet: sheet.name, ref, text: f.textContent ?? "" })));

describe("XLSX package patcher", () => {
  it("keeps drawings, extended validations, merges and print setup of the reference", () => {
    const source = new PizZip(fixtureBytes());
    const out = new PizZip(XlsxWorkbook.load(fixtureBytes()).toBytes());
    assert.ok(out.file("xl/drawings/drawing1.xml"), "CMR stamp circle");
    assert.equal(out.file("xl/drawings/drawing1.xml")!.asText(), source.file("xl/drawings/drawing1.xml")!.asText());
    assert.match(out.file("xl/worksheets/sheet1.xml")!.asText(), /x14:dataValidation/);
    for (const part of source.file(/xl\/worksheets\/sheet\d+\.xml$/)) {
      const before = part.asText(), after = out.file(part.name)!.asText();
      assert.equal((after.match(/<mergeCell /g) ?? []).length, (before.match(/<mergeCell /g) ?? []).length, `${part.name} merges`);
      assert.equal(after.match(/<pageMargins[^>]*>/)?.[0], before.match(/<pageMargins[^>]*>/)?.[0], `${part.name} margins`);
      assert.equal(after.match(/<pageSetup[^>]*orientation="(\w+)"/)?.[1], before.match(/<pageSetup[^>]*orientation="(\w+)"/)?.[1], `${part.name} orientation`);
      assert.equal(/<pageSetUpPr fitToPage="1"/.test(after), /<pageSetUpPr fitToPage="1"/.test(before), `${part.name} fit to page`);
    }
  });

  it("drops what must not leak: calc chain, local author path and stale shared strings", () => {
    const out = new PizZip(XlsxWorkbook.load(fixtureBytes()).toBytes());
    assert.equal(out.file("xl/calcChain.xml"), null);
    assert.doesNotMatch(out.file("xl/workbook.xml")!.asText(), /absPath/);
    assert.doesNotMatch(out.file("docProps/core.xml")!.asText(), /lastModifiedBy|Desktop/);
    assert.match(out.file("xl/sharedStrings.xml")!.asText(), /count="0"/);
  });

  it("recomputes every cached value consistently and flags full recalculation on open", () => {
    const first = XlsxWorkbook.load(fixtureBytes()).toBytes();
    const second = XlsxWorkbook.load(first).toBytes();
    const a = XlsxWorkbook.load(first), b = XlsxWorkbook.load(second);
    for (const sheet of a.sheets) for (const { ref } of sheet.formulaCells()) assert.equal(b.sheet(sheet.name).raw(ref), sheet.raw(ref), `${sheet.name}!${ref}`);
    assert.match(new PizZip(first).file("xl/workbook.xml")!.asText(), /fullCalcOnLoad="1"/);
  });

  it("inserts and deletes rows keeping merges and cross-sheet references", () => {
    const workbook = XlsxWorkbook.load(fixtureBytes());
    const lines = workbook.sheet("для Диляры");
    const before = formulasOf(workbook).find(item => item.sheet === "данные" && item.ref === "C23")!.text;
    assert.equal(before, "'для Диляры'!G24");
    lines.insertRows(24, 3, 23);
    assert.equal(formulasOf(workbook).find(item => item.sheet === "данные" && item.ref === "C23")!.text, "'для Диляры'!G27");
    assert.equal(lines.raw("B27"), "ИТОГО");
    lines.deleteRows(24, 3);
    assert.equal(formulasOf(workbook).find(item => item.sheet === "данные" && item.ref === "C23")!.text, "'для Диляры'!G24");
    assert.equal(lines.raw("B24"), "ИТОГО");
  });
});

describe("filling the reference workbook", () => {
  it("never modifies the template bytes", () => {
    const template = fixtureBytes();
    const hash = sha(template);
    fillExportWorkbook(template, buildExportModel(baseData(makeItems(2)))).toBytes();
    assert.equal(sha(template), hash);
  });

  it("fills inputs and the linked documents for a single item", () => {
    const book = reload(fill(baseData(makeItems(1))));
    const input = book.sheet("данные");
    assert.equal(input.raw("C2"), "TEST-ORDER-1");
    assert.equal(input.raw("C7"), "111AAA11");
    assert.equal(input.raw("C12"), 15);
    assert.equal(input.raw("C14"), "Казахстан", "country codes become names");
    assert.equal(book.sheet("CMR").raw("N1"), 16);
    assert.equal(book.sheet("CMR").raw("B15"), "Тестландия, г. Город-А, ул. Складская, 5");
    assert.equal(book.sheet("ТТН").raw("N2"), "ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ  № 15");
    assert.equal(book.sheet("упаков.лист").raw("K1"), 17);
    assert.equal(book.sheet("CMR").raw("H9"), "ТОО «Тест-Перевозчик»", "carrier is shown in CMR box 16");
    assert.equal(book.sheet("ТТН").raw("H9"), "Иванов И.И.");
    assert.equal(book.sheet("CMR").raw("A51"), "Автомобиль TESTTRUCK 111AAA11, Прицеп 22BBB22 TESTTRAILER");
    assert.equal(book.sheet("упаков.лист").raw("K4"), "к Контракту № T-777 от 31.12.2029");
    assert.equal(book.sheet("для Диляры").raw("C7"), "ТОО «Тест-Продавец» и ООО «Тест-Покупатель»");
  });

  it("computes table values and totals with the formulas of the reference", () => {
    const book = reload(fill(baseData(makeItems(1))));
    const lines = book.sheet("для Диляры"), packing = book.sheet("упаков.лист");
    assert.equal(lines.raw("E17"), 1000);
    assert.equal(lines.raw("D17"), 200, "net = pieces × net per piece");
    assert.equal(lines.raw("G17"), 10000);
    assert.equal(packing.raw("F12"), 200);
    assert.equal(packing.raw("G12"), 206, "reference factor 1.03 is kept");
    assert.equal(packing.raw("H12"), 50, "boxes = pieces / pieces per box");
    assert.equal(packing.raw("K12"), 325, "reference rule: gross + 25 kg per pallet");
    assert.equal(book.sheet("данные").raw("C26"), 325);
    assert.equal(book.sheet("CMR").raw("L28"), 325);
    assert.equal(book.sheet("ТТН").raw("X27"), 325);
    assert.equal(book.sheet("CMR").raw("C37"), 10000, "declared value follows the price total");
    assert.equal(book.sheet("ТТН").raw("N27"), 10000);
  });

  it("removes unused table rows and keeps the footer connected", () => {
    const workbook = fill(baseData(makeItems(2)));
    const book = reload(workbook);
    const lines = book.sheet("для Диляры"), packing = book.sheet("упаков.лист");
    assert.equal(lines.raw("B19"), "ИТОГО");
    assert.equal(packing.raw("A14"), null);
    assert.equal(packing.raw("A13"), 2);
    assert.equal(packing.formula("E14"), "SUM(E12:E13)");
    assert.equal(packing.raw("A18"), "Покупатель", "footer moved up by the four removed rows");
    assert.equal(packing.raw("A19"), "ООО «Тест-Покупатель»");
    assert.equal(book.sheet("данные").formula("C26"), "упаков.лист!K14");
  });

  it("adds rows, repeats the header and lets the packing list continue on further pages", () => {
    const items = makeItems(15);
    const book = reload(fill(baseData(items)));
    const packing = book.sheet("упаков.лист"), lines = book.sheet("для Диляры");
    assert.equal(packing.raw("A26"), 15);
    assert.equal(packing.formula("E27"), "SUM(E12:E26)");
    assert.equal(packing.raw("E27"), items.reduce((sum, item) => sum + Number(item.piece_count), 0));
    assert.equal(lines.raw("B32"), "ИТОГО");
    assert.equal(lines.formula("D32"), "SUM(D17:D31)");
    assert.equal(packing.pageSetup!.getAttribute("fitToHeight"), "0");
    assert.match(new PizZip(book.toBytes()).file("xl/workbook.xml")!.asText(), /Print_Titles[^>]*>'упаков\.лист'!\$9:\$11</);
    // the sums that CMR / ТТН show still point at the moved totals
    assert.equal(book.sheet("данные").formula("C26"), "упаков.лист!K27");
    assert.equal(book.sheet("CMR").raw("L28"), packing.raw("K27"));
    assert.equal(packing.raw("A31"), "Покупатель", "footer moved down by the nine added rows");
    assert.equal(packing.raw("A32"), "ООО «Тест-Покупатель»");
    for (const { text } of formulasOf(book)) assert.doesNotMatch(text, /#REF/);
  });

  it("does not add print repetition when the table fits the sample page", () => {
    const book = reload(fill(baseData(makeItems(6))));
    assert.doesNotMatch(new PizZip(book.toBytes()).file("xl/workbook.xml")!.asText(), /Print_Titles/);
    assert.ok([null, "1"].includes(book.sheet("упаков.лист").pageSetup!.getAttribute("fitToHeight")), "sample print scaling untouched");
  });

  it("splits a product with several expiry dates into merged batch rows", () => {
    const items = makeItems(2, index => index === 0 ? { batches: [{ quantity: 600, expiry_date: "2031-05-01" }, { quantity: 400, expiry_date: "2031-06-01" }] } : {});
    const book = reload(fill(baseData(items)));
    const lines = book.sheet("для Диляры"), packing = book.sheet("упаков.лист");
    assert.deepEqual(lines.mergeRanges.sort(), ["A17:A18", "B17:B18", "C17:C18", "H17:H18"]);
    assert.equal(lines.raw("E17"), 600);
    assert.equal(lines.raw("E18"), 400);
    assert.equal(lines.raw("A19"), 2);
    assert.equal(packing.formula("E12"), "SUM('для Диляры'!E17:E18)");
    assert.equal(packing.raw("E12"), 1000);
    assert.equal(packing.formula("D13"), "'для Диляры'!C19");
    assert.equal(lines.raw("I17") !== lines.raw("I18"), true);
  });

  it("leaves price columns and totals blank when prices are not included", () => {
    const book = reload(fill(baseData(makeItems(2, () => ({ unit_price: null })))));
    const lines = book.sheet("для Диляры");
    assert.equal(lines.raw("F17"), null);
    assert.equal(lines.raw("G19"), "");
    assert.equal(book.sheet("CMR").raw("C37"), "", "no misleading 0 as declared value");
    assert.equal(book.sheet("ТТН").raw("N27"), "");
  });

  it("shows blank text instead of 0 for optional inputs that are missing", () => {
    const book = reload(fill(baseData(makeItems(1), { trailer_plate: "", trailer_make: "", loading_city: "", seals: "" })));
    assert.equal(book.sheet("CMR").raw("B19"), "");
    assert.equal(book.sheet("ТТН").raw("C32"), "");
    assert.equal(book.sheet("ТТН").raw("N19"), "");
  });

  it("does not carry over text or numbers of the sample into the result", () => {
    const sampleOnly = ["Тест-Продавец", "Тест-Покупатель", "T-000", "TEST-1", "Тестов Тест Тестович", "000TST00", "тестовые кондитерские изделия", "0000000000001", "Тестовый товар А"];
    const out = new PizZip(fill(baseData(makeItems(2), { supplier_name: "ТОО «Новый-Продавец»", customer_name: "ООО «Новый-Покупатель»", unloading_address: "Новый адрес", contract_number: "N-1" })).toBytes());
    // Word-boundary match: the digits of a sample barcode must not be confused with a row height like ht="19.600000000000001".
    const present = (xml: string, token: string) => {
      for (let index = xml.indexOf(token); index >= 0; index = xml.indexOf(token, index + 1)) {
        const before = xml[index - 1] ?? "", after = xml[index + token.length] ?? "";
        if (!/[\d.]/.test(before) && !/\d/.test(after)) return true;
      }
      return false;
    };
    for (const part of out.file(/\.xml$/)) for (const token of sampleOnly) assert.ok(!present(part.asText(), token), `${token} still present in ${part.name}`);
  });

  it("clears the author's notes under the input block", () => {
    const book = reload(fill(baseData(makeItems(1))));
    for (const cell of ["C29", "C30", "C31"]) assert.equal(book.sheet("данные").raw(cell), null);
  });

  it("refuses a workbook that is not the reference layout", () => {
    const edited = XlsxWorkbook.load(fixtureBytes());
    edited.sheet("для Диляры").set("B24", "Итог");
    assert.throws(() => fillExportWorkbook(edited.toBytes(), buildExportModel(baseData(makeItems(1)))), TemplateLayoutError);
    const missing = XlsxWorkbook.load(fixtureBytes());
    missing.removeSheet("CMR");
    assert.throws(() => fillExportWorkbook(missing.toBytes(), buildExportModel(baseData(makeItems(1)))), /обязательного листа/);
  });
});

describe("CMR, ТТН and packing list as sheets of the filled book", () => {
  const full = fill(baseData(makeItems(3))).toBytes();

  for (const [output, sheetName] of Object.entries(OUTPUT_SHEETS)) {
    it(`${output}: one-sheet workbook with values, same cells and print setup as in the filled book`, () => {
      const single = XlsxWorkbook.load(extractSheetWorkbook(full, sheetName));
      assert.deepEqual(single.sheetNames(), [sheetName]);
      const source = XlsxWorkbook.load(full).sheet(sheetName);
      assert.equal([...single.sheet(sheetName).formulaCells()].length, 0, "formulas are frozen into values");
      for (const ref of source.contentCells()) assert.deepEqual(single.sheet(sheetName).raw(ref), source.raw(ref), ref);
      assert.deepEqual(single.sheet(sheetName).mergeRanges, source.mergeRanges);
      assert.deepEqual(single.sheet(sheetName).columnWidths(), source.columnWidths());
      assert.equal(single.sheet(sheetName).pageSetup!.getAttribute("orientation"), source.pageSetup!.getAttribute("orientation"));
      assert.equal(single.sheet(sheetName).state, "visible");
    });
  }

  it("keeps the CMR stamp circle and leaves no data of other sheets behind", () => {
    const parts = new PizZip(extractSheetWorkbook(full, "CMR"));
    assert.ok(parts.file(/drawings\/drawing\d+\.xml$/).length === 1);
    assert.equal(parts.file(/xl\/worksheets\/sheet\d+\.xml$/).length, 1);
    for (const part of parts.file(/\.xml$/)) assert.doesNotMatch(part.asText(), /Тестовый товар|T-100|для Диляры/);
  });

  it("builds the whole package from the template with prices, and refuses incomplete data", () => {
    const documents = buildExportDocuments(fixtureBytes(), baseData(makeItems(2)), ["workbook", "cmr", "ttn", "packing_list"]);
    assert.deepEqual(documents.map(item => item.output), ["workbook", "cmr", "ttn", "packing_list"]);
    assert.ok(documents.every(item => item.bytes.length > 1000));
    assert.throws(() => buildExportDocuments(fixtureBytes(), baseData(makeItems(1), { driver_name: "", cmr_number: "" }), ["cmr"]), PreflightError);
  });
});

describe("pre-flight check", () => {
  it("passes complete data and lists only recommendations", () => {
    const result = preflightExport(buildExportModel(baseData(makeItems(2))), ["workbook", "cmr", "ttn", "packing_list"]);
    assert.equal(result.ready, true);
    assert.equal(result.requiredMissing, 0);
    assert.ok(result.issues.every(issue => issue.severity === "recommended"));
    assert.ok(result.issues.some(issue => issue.key === "sellerAddress"), "requisites without a source are reported, not invented");
  });

  it("names every missing required field with its cells and source", () => {
    const data = baseData(makeItems(2, index => index === 1 ? { total_gross_weight_kg: null, box_count: null, hs_code: "" } : {}), { driver_name: "", unloading_address: "", cmr_number: "" });
    const result = preflightExport(buildExportModel(data), ["cmr", "packing_list"]);
    assert.equal(result.ready, false);
    const labels = result.issues.filter(issue => issue.severity === "required").map(issue => issue.label);
    assert.ok(labels.includes("Фамилия и инициалы водителя"));
    assert.ok(labels.includes("CMR №"));
    assert.ok(labels.some(label => label.startsWith("Позиция 2") && label.includes("вес брутто")));
    assert.ok(labels.some(label => label.startsWith("Позиция 2") && label.includes("штук в транспортном коробе")));
    const driver = result.issues.find(issue => issue.key === "driverName")!;
    assert.match(driver.where, /данные!C5/);
    assert.ok(driver.source.length > 0);
  });

  it("only asks for what the chosen documents show", () => {
    const data = baseData(makeItems(1), { ttn_number: "", cmr_number: "", seals: "" });
    assert.equal(preflightExport(buildExportModel(data), ["packing_list"]).issues.some(issue => issue.key === "ttnNumber"), false);
    assert.equal(preflightExport(buildExportModel(data), ["ttn"]).issues.some(issue => issue.key === "ttnNumber"), true);
    assert.equal(preflightExport(buildExportModel(data), ["workbook"]).issues.some(issue => issue.key === "cmrNumber"), true);
  });

  it("blocks an empty shipment", () => {
    const result = preflightExport(buildExportModel(baseData([])), ["workbook"]);
    assert.equal(result.ready, false);
    assert.ok(result.issues.some(issue => issue.key === "items"));
  });
});

describe("visual layout checks", () => {
  const LAYOUT_SHEETS = ["CMR", "ТТН", "фура, водила", "Инструкция"] as const;

  it("form sheets keep exactly the layout of the reference (merges, widths, heights, print setup)", () => {
    const reference = XlsxWorkbook.load(fixtureBytes());
    const filled = reload(fill(baseData(makeItems(9))));
    for (const name of LAYOUT_SHEETS) {
      const before = reference.sheet(name), after = filled.sheet(name);
      assert.deepEqual(after.mergeRanges.sort(), before.mergeRanges.sort(), `${name} merges`);
      assert.deepEqual(after.columnWidths(), before.columnWidths(), `${name} widths`);
      for (let row = 1; row <= 60; row++) assert.equal(after.rowHeight(row), before.rowHeight(row), `${name} row ${row}`);
      assert.equal(after.pageSetup!.outerHTML ?? after.pageSetup!.toString(), before.pageSetup!.outerHTML ?? before.pageSetup!.toString());
    }
  });

  it("table rows keep the borders and formats of the reference rows (first, regular, last, totals)", () => {
    const reference = XlsxWorkbook.load(fixtureBytes());
    const filled = reload(fill(baseData(makeItems(9))));
    const style = (workbook: XlsxWorkbook, ref: string) => workbook.sheet("упаков.лист").cellElement(ref)?.getAttribute("s");
    // 9 items: the original rows 12..16 stay, three regular rows are added before the last row, totals follow.
    const expected = (row: number) => row <= 16 ? row : row <= 19 ? 15 : row === 20 ? 17 : 18;
    for (const column of "ABCDEFGHIJK") for (let row = 12; row <= 21; row++) assert.equal(style(filled, `${column}${row}`), style(reference, `${column}${expected(row)}`), `${column}${row}`);
  });

  it("removing rows keeps the first and last row styles", () => {
    const reference = XlsxWorkbook.load(fixtureBytes());
    const filled = reload(fill(baseData(makeItems(3))));
    const style = (workbook: XlsxWorkbook, ref: string) => workbook.sheet("упаков.лист").cellElement(ref)?.getAttribute("s");
    for (const column of "ABCDEFGHIJK") {
      assert.equal(style(filled, `${column}12`), style(reference, `${column}12`));
      assert.equal(style(filled, `${column}14`), style(reference, `${column}17`), "last data row");
      assert.equal(style(filled, `${column}15`), style(reference, `${column}18`), "totals row");
    }
  });

  it("renders the sheets to HTML with merged cells and the filled values", () => {
    const book = reload(fill(baseData(makeItems(3))));
    const cmr = renderSheetHtml(book, "CMR");
    assert.ok(/colspan="6"/.test(cmr), "merged cells become colspan");
    assert.ok(cmr.includes("ТОО «Тест-Продавец»") && cmr.includes("ООО «Тест-Покупатель»"));
    const packing = renderSheetHtml(book, "упаков.лист");
    assert.ok(packing.includes("Тестовый товар 3"));
    assert.ok(/1 200</.test(packing), "grouped number format of the sheet");
  });
});
