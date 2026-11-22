import "server-only";

import { PublicError } from "@/lib/errors/public-message";
import { sheetsAccessToken } from "@/lib/google/calculator-sheet";
import { DRIVE_ID } from "@/lib/google/drive-readonly";
import type { Cell } from "@/lib/reference-import/normalize.ts";

// Reads two sheets of an order workbook («Вн расчеты») with spreadsheets.readonly. The caller has already checked on
// Drive that the file lies inside the shipment's bound folder. Values only, bounded; nothing is written to Google.
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_ROWS = 600, MAX_COLUMNS = 120;

function cells(value: unknown): Cell[][] {
  const rows = value && typeof value === "object" ? (value as { values?: unknown }).values : undefined;
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new PublicError("Лист таблицы слишком большой или повреждён.");
  return rows.map(row => {
    if (!Array.isArray(row) || row.length > MAX_COLUMNS) throw new PublicError("Лист таблицы слишком большой или повреждён.");
    return row.map(cell => {
      if (cell === null || cell === undefined) return null;
      if (["string", "number", "boolean"].includes(typeof cell)) return cell as string | number | boolean;
      throw new PublicError("Google Sheets вернул неподдерживаемое значение ячейки.");
    });
  });
}

async function sheet(id: string, name: string, columns: string, required: boolean): Promise<Cell[][]> {
  const range = encodeURIComponent(`'${name}'!A1:${columns}${MAX_ROWS}`);
  const response = await fetch(`${SHEETS_API}/${id}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, {
    method: "GET", headers: { Authorization: `Bearer ${await sheetsAccessToken()}`, Accept: "application/json" },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (response.status === 400 && !required) return [];
  if (response.status === 400) throw new PublicError(`В таблице нет листа «${name}».`);
  if (response.status === 403 || response.status === 404) throw new PublicError("Служебному аккаунту не выдан доступ к этой таблице.");
  if (!response.ok) throw new PublicError("Не удалось прочитать таблицу из Google Sheets.");
  return cells(await response.json());
}

export async function readOrderWorkbookSheets(spreadsheetId: string) {
  if (!DRIVE_ID.test(spreadsheetId)) throw new PublicError("Некорректная таблица.");
  const [calculation, client] = await Promise.all([sheet(spreadsheetId, "Расчеты", "DZ", true), sheet(spreadsheetId, "От клиента", "Z", false)]);
  return { calculation, client };
}
