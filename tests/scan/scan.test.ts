import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BitArray, Code128Reader, DecodeHintType } from "@zxing/library";
import { code128Modules, code128Widths } from "../../src/lib/scan/code128.ts";
import { gs1Date, gtinValid, looksLikeGs1, parseGs1 } from "../../src/lib/scan/gs1.ts";
import { inputSource, type KeyStroke } from "../../src/lib/scan/input.ts";

const GS = "\u001d";
const today = new Date("2026-11-28T00:00:00Z");

describe("GS1 element strings", () => {
  it("reads GTIN, batch, expiry and quantity from GS1-128 with FNC1 separators", () => {
    const result = parseGs1(`]C10104601234567893` + `10LOT-77${GS}17270531` + `3724`, today);
    assert.deepEqual(result.ok && [result.gtin, result.batch, result.expiry, result.quantity], ["04601234567893", "LOT-77", "2027-05-31", 24]);
  });
  it("reads the bracketed human-readable form and a DataMatrix without a symbology identifier", () => {
    const bracketed = parseGs1("(01)04601234567893(17)280200(10)A1", today);
    assert.ok(bracketed.ok && bracketed.expiry === "2028-02-29" && bracketed.batch === "A1", "day 00 is the last day of the month");
    const matrix = parseGs1(`010460123456789321QwErTy123${GS}91EE07${GS}92abcdefgh`, today);
    assert.ok(matrix.ok && matrix.gtin === "04601234567893" && matrix.serial === "QwErTy123", "a marking code is the product by GTIN");
  });
  it("refuses broken codes instead of guessing", () => {
    assert.deepEqual(parseGs1("(01)04601234567890", today), { ok: false, error: "bad_gtin" });
    assert.deepEqual(parseGs1("(01)0460123456789", today), { ok: false, error: "bad_length" });
    assert.deepEqual(parseGs1("(01)04601234567893(17)271332", today), { ok: false, error: "bad_date" });
    assert.deepEqual(parseGs1("(01)04601234567893(37)12a", today), { ok: false, error: "bad_quantity" });
    assert.deepEqual(parseGs1(`]C1010460123456789388X`, today), { ok: false, error: "unknown_ai" });
    assert.deepEqual(parseGs1("4601234567893", today), { ok: false, error: "not_gs1" });
    assert.deepEqual(parseGs1("NX-7KQ2M9TA", today), { ok: false, error: "not_gs1" });
  });
  it("tells GS1 from plain barcodes and labels; checks GTIN digits and GS1 dates", () => {
    assert.ok(looksLikeGs1("(01)04601234567893") && looksLikeGs1(`]d201046012345678931712`) && !looksLikeGs1("4601234567893"));
    assert.ok(gtinValid("4601234567893") && gtinValid("04601234567893") && !gtinValid("4601234567890") && !gtinValid("12345"));
    assert.equal(gs1Date("800101", today), "1980-01-01", "more than 50 years ahead is the previous century");
    assert.equal(gs1Date("750101", today), "2075-01-01", "up to 50 years ahead stays in this century");
    assert.equal(gs1Date("300101", today), "2030-01-01");
  });
});

describe("scanner or typing", () => {
  const strokes = (text: string, gap: number, enter = true): KeyStroke[] =>
    [...[...text].map((key, index) => ({ key, at: 1000 + index * gap })), ...(enter ? [{ key: "Enter", at: 1000 + text.length * gap }] : [])];
  it("a scanner sends the code in milliseconds and ends with Enter; a person types slower", () => {
    assert.equal(inputSource(strokes("4601234567893", 8)), "scanner");
    assert.equal(inputSource(strokes("4601234567893", 140)), "manual");
    assert.equal(inputSource(strokes("4601234567893", 8, false)), "manual", "no Enter: not a finished scan");
    assert.equal(inputSource(strokes("12", 5)), "manual", "too short to tell");
  });
});

describe("Code 128 of Nexus labels", () => {
  it("is read back by the Code 128 reader of zxing", () => {
    for (const text of ["NX-7KQ2M9TA", "NX-0000ZZZZ", "Hello, 128!"]) {
      const modules = code128Modules(text);
      const row = new BitArray(modules.length);
      modules.forEach((bar, index) => { if (bar) row.set(index); });
      const result = new Code128Reader().decodeRow(0, row, new Map([[DecodeHintType.ASSUME_GS1, false]]));
      assert.equal(result.getText(), text);
    }
  });
  it("refuses what code set B cannot carry", () => {
    assert.throws(() => code128Widths("Код"));
    assert.equal(code128Widths("NX-1").reduce((a, b) => a + b, 0), 11 * 6 + 13, "start, 4 characters, checksum: 11 modules each; stop 13");
  });
});
