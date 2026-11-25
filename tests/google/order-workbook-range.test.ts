import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORDER_WORKBOOK_MAX_ROWS, columnNumber, orderWorkbookCells, orderWorkbookRange } from "../../src/lib/google/order-workbook-range.ts";

// Audit 24.11.2026, Б4: the «Расчеты» sheet was requested as A1:DZ600 and rows past 600 were lost silently, while any
// value in columns 121–130 (DQ–DZ) stopped the read as a «damaged» sheet. Synthetic values only.
describe("order workbook sheet bounds", () => {
  it("counts columns by letters", () => {
    assert.equal(columnNumber("A"), 1);
    assert.equal(columnNumber("Z"), 26);
    assert.equal(columnNumber("AZ"), 52);
    assert.equal(columnNumber("DZ"), 130);
    assert.throws(() => columnNumber("dz"));
  });

  it("asks for one row past the limit, so a longer sheet is noticed", () => {
    assert.equal(orderWorkbookRange("Расчеты", "DZ"), `'Расчеты'!A1:DZ${ORDER_WORKBOOK_MAX_ROWS + 1}`);
    assert.throws(() => orderWorkbookRange("Лист'1", "Z"));
  });

  it("reads a sheet up to the limit and stops with a message above it", () => {
    const full = Array.from({ length: ORDER_WORKBOOK_MAX_ROWS }, (_, row) => [`SKU-${row}`, row]);
    assert.equal(orderWorkbookCells({ values: full }, "Расчеты", "DZ").length, ORDER_WORKBOOK_MAX_ROWS);
    assert.throws(() => orderWorkbookCells({ values: [...full, ["SKU-extra", 1]] }, "Расчеты", "DZ"),
      { name: "PublicError", message: new RegExp(`В листе «Расчеты» больше ${ORDER_WORKBOOK_MAX_ROWS} строк`) });
  });

  it("accepts a value in the last requested column and refuses a wider row", () => {
    const last = Array.from({ length: 130 }, (_, column) => (column === 129 ? "DZ" : null));
    assert.equal(orderWorkbookCells({ values: [last] }, "Расчеты", "DZ")[0][129], "DZ");
    assert.throws(() => orderWorkbookCells({ values: [[...last, "past DZ"]] }, "Расчеты", "DZ"), { name: "PublicError" });
  });

  it("treats a response without values as an empty sheet and refuses unsupported cells", () => {
    assert.deepEqual(orderWorkbookCells({}, "Стикеры", "P"), []);
    assert.throws(() => orderWorkbookCells({ values: [[{ formula: "=1" }]] }, "Стикеры", "P"), { name: "PublicError" });
  });
});
