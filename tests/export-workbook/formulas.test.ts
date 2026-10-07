import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateFormula, FormulaError, type Scalar } from "../../src/lib/export-workbook/formula-eval.ts";
import { colToNumber, shiftFormulaRows, translateFormula } from "../../src/lib/export-workbook/refs.ts";

const sheet = (cells: Record<string, Scalar>) => ({
  cell: (name: string, col: number, row: number) => {
    const letters = (n: number) => { let out = ""; for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) out = String.fromCharCode(65 + ((v - 1) % 26)) + out; return out; };
    return cells[`${name}!${letters(col)}${row}`] ?? null;
  },
});

describe("formula references", () => {
  it("shifts rows after insertion and keeps $-anchors and other sheets", () => {
    assert.equal(shiftFormulaRows("SUM(D17:D23)", "A", "A", 24, 3), "SUM(D17:D23)");
    assert.equal(shiftFormulaRows("'для Диляры'!G24", "данные", "для Диляры", 24, 3), "'для Диляры'!G27");
    assert.equal(shiftFormulaRows("упаков.лист!K18", "данные", "упаков.лист", 18, 5), "упаков.лист!K23");
    assert.equal(shiftFormulaRows("F25+$A$30", "CMR", "CMR", 20, 2), "F27+$A$32");
    assert.equal(shiftFormulaRows("F25", "CMR", "ТТН", 20, 2), "F25");
  });

  it("collapses ranges instead of pointing into deleted rows", () => {
    // rows 14..16 deleted: a range ending inside them ends at the last surviving row
    assert.equal(shiftFormulaRows("SUM(D10:D16)", "A", "A", 14, -3), "SUM(D10:D13)");
    assert.equal(shiftFormulaRows("D20", "A", "A", 14, -3), "D17");
  });

  it("ignores string literals and function names", () => {
    assert.equal(shiftFormulaRows('CONCATENATE("A24 ",данные!C21," от ")', "CMR", "данные", 21, 2), 'CONCATENATE("A24 ",данные!C23," от ")');
    assert.equal(shiftFormulaRows("LOG10(A5)", "S", "S", 1, 1), "LOG10(A6)");
  });

  it("translates relative references like a copied formula", () => {
    assert.equal(translateFormula("J12+I12*25", 3, 0), "J15+I15*25");
    assert.equal(translateFormula("$A$1+B2", 2, 1), "$A$1+C4");
  });

  it("converts column letters", () => {
    assert.equal(colToNumber("AA"), 27);
  });
});

describe("formula evaluator", () => {
  const data = sheet({ "S!A1": 4, "S!A2": 6, "S!B1": "текст", "S!C1": "", "T!A1": 10 });
  const run = (formula: string) => evaluateFormula(formula, "S", data);

  it("evaluates arithmetic, ranges and cross-sheet references", () => {
    assert.equal(run("A1*0.5+A2"), 8);
    assert.equal(run("SUM(A1:A2)"), 10);
    assert.equal(run("SUM(A1:B1)"), 4, "text inside a range is ignored like in Excel");
    assert.equal(run("T!A1+1"), 11);
    assert.equal(run("-A1+(2+3)*2"), 6);
  });

  it("evaluates IF, comparisons and CONCATENATE the way the template uses them", () => {
    assert.equal(run('IF(C1="","ОШИБКА","")'), "ОШИБКА");
    assert.equal(run('IF(A1="","ОШИБКА","")'), "");
    assert.equal(run('CONCATENATE("№ ",A1," от ",B1)'), "№ 4 от текст");
    assert.equal(run('"a"&A1'), "a4");
  });

  it("treats blank cells as 0 in arithmetic and empty text in joins", () => {
    assert.equal(run("Z9+1"), 1);
    assert.equal(run('CONCATENATE("x",Z9)'), "x");
  });

  it("reports division by zero and unsupported functions explicitly", () => {
    assert.throws(() => run("A1/0"), (error: unknown) => error instanceof FormulaError && error.message === "#DIV/0!");
    assert.throws(() => run("VLOOKUP(A1,A1:A2,1)"), /не поддерживается/);
  });
});
