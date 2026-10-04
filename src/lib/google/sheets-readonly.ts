import type { Cell } from "@/lib/reference-import/normalize.ts";

export const GOOGLE_SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const CALCULATOR_SPREADSHEET_ID = "1VO6lGgt4-qa9NdPVBPjqO15ssNr67wdXE2yJxkDPmFw";
export const CALCULATOR_SHEET_NAME = "расчеты";
export const CALCULATOR_SOURCE_TITLE = "01 мастер калькулятор KZ · Google Sheets";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 500;
const MAX_CELLS = 500_000;

type GoogleValues = { values?: unknown };

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value as string | number | boolean;
  throw new Error("Google Sheets вернул неподдерживаемое значение ячейки.");
}

export function calculatorValuesUrl() {
  const range = encodeURIComponent(`'${CALCULATOR_SHEET_NAME}'`);
  return `${SHEETS_API}/${CALCULATOR_SPREADSHEET_ID}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
}

export function parseGoogleValues(value: unknown): Cell[][] {
  if (!value || typeof value !== "object" || !Array.isArray((value as GoogleValues).values)) {
    throw new Error("Google Sheets вернул ответ без строк листа.");
  }
  const source = (value as GoogleValues).values as unknown[];
  if (source.length < 6 || source.length > MAX_ROWS) {
    throw new Error(`Лист «${CALCULATOR_SHEET_NAME}» содержит недопустимое количество строк.`);
  }
  let cells = 0;
  return source.map((raw, index) => {
    if (!Array.isArray(raw)) throw new Error(`Google Sheets вернул некорректную строку ${index + 1}.`);
    if (raw.length > MAX_COLUMNS) throw new Error(`Строка ${index + 1} содержит слишком много колонок.`);
    cells += raw.length;
    if (cells > MAX_CELLS) throw new Error("Лист слишком большой для безопасной синхронизации.");
    return raw.map(cell);
  });
}
