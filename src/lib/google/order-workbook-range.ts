import { PublicError } from "../errors/public-message.ts";
import type { Cell } from "../reference-import/normalize.ts";

// Bounds of the sheets read from an order workbook («Вн расчеты», audit 24.11.2026, Б4). The range asks Google for one
// row more than Nexus reads, so a longer sheet stops with a message instead of losing its last rows silently, and the
// column bound is the range's own last column, so a value in the last requested columns is never taken for a damaged
// sheet.
export const ORDER_WORKBOOK_MAX_ROWS = 2000;

/** The number of a column by its letters: A → 1, Z → 26, AZ → 52, DZ → 130. */
export function columnNumber(letters: string): number {
  if (!/^[A-Z]{1,3}$/.test(letters)) throw new Error(`Некорректная колонка: ${letters}`);
  return [...letters].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
}

/** The A1 range of a sheet up to its last column, one row past the limit. */
export function orderWorkbookRange(sheet: string, lastColumn: string): string {
  columnNumber(lastColumn);
  if (!sheet || sheet.length > 100 || sheet.includes("'")) throw new Error("Некорректное название листа.");
  return `'${sheet}'!A1:${lastColumn}${ORDER_WORKBOOK_MAX_ROWS + 1}`;
}

/** Cell values of a Sheets values response for that range; no values means an empty sheet. */
export function orderWorkbookCells(value: unknown, sheet: string, lastColumn: string): Cell[][] {
  const rows = value && typeof value === "object" ? (value as { values?: unknown }).values : undefined;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new PublicError("Лист таблицы повреждён.");
  if (rows.length > ORDER_WORKBOOK_MAX_ROWS) {
    throw new PublicError(`В листе «${sheet}» больше ${ORDER_WORKBOOK_MAX_ROWS} строк: Nexus читает не больше ${ORDER_WORKBOOK_MAX_ROWS}. Сократите лист или разделите таблицу.`);
  }
  const columns = columnNumber(lastColumn);
  return rows.map(row => {
    if (!Array.isArray(row) || row.length > columns) throw new PublicError("Лист таблицы повреждён.");
    return row.map(cell => {
      if (cell === null || cell === undefined) return null;
      if (["string", "number", "boolean"].includes(typeof cell)) return cell as string | number | boolean;
      throw new PublicError("Google Sheets вернул неподдерживаемое значение ячейки.");
    });
  });
}
