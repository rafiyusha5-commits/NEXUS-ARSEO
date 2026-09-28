import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createXlsx } from "../../src/lib/xlsx.ts";

describe("shipment report XLSX", () => {
  it("creates an Office Open XML ZIP with every requested sheet", () => {
    const file = createXlsx([
      { name: "Сводка", rows: [["Показатель", "Значение"], ["Принято", 480]] },
      { name: "Позиции", rows: [["Артикул", "Товар"], ["SKU-1", "Dumle"]] },
    ]);
    assert.equal(file.readUInt32LE(0), 0x04034b50);
    assert.ok(file.includes(Buffer.from("[Content_Types].xml")));
    assert.ok(file.includes(Buffer.from("xl/worksheets/sheet1.xml")));
    assert.ok(file.includes(Buffer.from("xl/worksheets/sheet2.xml")));
    assert.equal(file.readUInt32LE(file.length - 22), 0x06054b50);
  });

  it("sanitizes worksheet names that Excel rejects", () => {
    const file = createXlsx([{ name: "Партии/сроки:*?", rows: [["Партия"]] }]);
    assert.ok(file.length > 500);
    assert.ok(file.readUInt16LE(file.length - 12) >= 6);
  });
});
