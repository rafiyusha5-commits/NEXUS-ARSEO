import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CALCULATOR_SHEET_NAME,
  CALCULATOR_SPREADSHEET_ID,
  GOOGLE_SHEETS_READONLY_SCOPE,
  calculatorValuesUrl,
  parseGoogleValues,
} from "../../src/lib/google/sheets-readonly.ts";

describe("Google Sheets calculator source", () => {
  it("is pinned to the approved sheet and the read-only OAuth scope", () => {
    assert.equal(CALCULATOR_SPREADSHEET_ID, "1VO6lGgt4-qa9NdPVBPjqO15ssNr67wdXE2yJxkDPmFw");
    assert.equal(CALCULATOR_SHEET_NAME, "расчеты");
    assert.equal(GOOGLE_SHEETS_READONLY_SCOPE, "https://www.googleapis.com/auth/spreadsheets.readonly");
    const url = calculatorValuesUrl();
    assert.match(url, /sheets\.googleapis\.com\/v4\/spreadsheets\/[^/]+\/values\//);
    assert.doesNotMatch(url, /append|update|batchUpdate|clear/i);
  });

  it("accepts only scalar cell values from a bounded values response", () => {
    const rows = parseGoogleValues({ values: [
      [1, "код", true],
      [],
      ["Блок"],
      ["Field"],
      ["Поле"],
      ["Товар"],
    ] });
    assert.deepEqual(rows[0], [1, "код", true]);
    assert.equal(rows.length, 6);
    assert.throws(() => parseGoogleValues({ values: [[1], [], [], [], [], [{ formula: "write" }]] }), /неподдерживаемое значение/);
  });
});
