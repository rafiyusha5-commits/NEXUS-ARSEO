import { it } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { exportCalculation } from "../../src/lib/replenishment/export.ts";
import { fixture } from "./fixture.ts";
it("Excel round-trips numeric facts, Unicode and treats formula-like SKUs as text", async () => {
  const data = fixture(); data.products[0].sku = '=HYPERLINK("https://invalid.test")';
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exportCalculation(data, "synthetic") as never);
  assert.equal(workbook.worksheets.length, 4); const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell("A4").value, data.products[0].sku); assert.equal(sheet.getCell("B4").value, "Астана");
  assert.equal(sheet.getCell("H4").value, 140); assert.equal(sheet.getCell("I4").value, 140);
  assert.equal(sheet.getCell("A4").type, ExcelJS.ValueType.String);
});
