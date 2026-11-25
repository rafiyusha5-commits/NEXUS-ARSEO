import "server-only";

import { PublicError } from "@/lib/errors/public-message";
import { sheetsAccessToken } from "@/lib/google/calculator-sheet";
import { DRIVE_ID } from "@/lib/google/drive-readonly";
import { orderWorkbookCells, orderWorkbookRange } from "@/lib/google/order-workbook-range";
import type { Cell } from "@/lib/reference-import/normalize.ts";

// Reads the sheets of an order workbook («Вн расчеты») with spreadsheets.readonly. The caller has already checked on
// Drive that the file lies inside the shipment's bound folder. Values only, bounded (order-workbook-range.ts); nothing
// is written to Google.
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheet(id: string, name: string, columns: string, required: boolean): Promise<Cell[][]> {
  const range = encodeURIComponent(orderWorkbookRange(name, columns));
  const response = await fetch(`${SHEETS_API}/${id}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, {
    method: "GET", headers: { Authorization: `Bearer ${await sheetsAccessToken()}`, Accept: "application/json" },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (response.status === 400 && !required) return [];
  if (response.status === 400) throw new PublicError(`В таблице нет листа «${name}».`);
  if (response.status === 403 || response.status === 404) throw new PublicError("Служебному аккаунту не выдан доступ к этой таблице.");
  if (!response.ok) throw new PublicError("Не удалось прочитать таблицу из Google Sheets.");
  return orderWorkbookCells(await response.json(), name, columns);
}

export async function readOrderWorkbookSheets(spreadsheetId: string) {
  if (!DRIVE_ID.test(spreadsheetId)) throw new PublicError("Некорректная таблица.");
  const [calculation, client, customs, stickers, distribution] = await Promise.all([
    sheet(spreadsheetId, "Расчеты", "DZ", true), sheet(spreadsheetId, "От клиента", "Z", false),
    sheet(spreadsheetId, "Растаможка", "Z", false), sheet(spreadsheetId, "Стикеры", "P", false), sheet(spreadsheetId, "Распределение", "AZ", false),
  ]);
  return { calculation, client, customs, stickers, distribution };
}

/** The first sheet of a separate distribution spreadsheet («Распределение …»). */
export async function readFirstSheet(spreadsheetId: string): Promise<Cell[][]> {
  if (!DRIVE_ID.test(spreadsheetId)) throw new PublicError("Некорректная таблица.");
  const response = await fetch(`${SHEETS_API}/${spreadsheetId}?fields=sheets.properties.title`, {
    method: "GET", headers: { Authorization: `Bearer ${await sheetsAccessToken()}`, Accept: "application/json" },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (response.status === 403 || response.status === 404) throw new PublicError("Служебному аккаунту не выдан доступ к этой таблице.");
  if (!response.ok) throw new PublicError("Не удалось прочитать таблицу из Google Sheets.");
  const data = await response.json() as { sheets?: { properties?: { title?: unknown } }[] };
  const title = data.sheets?.[0]?.properties?.title;
  if (typeof title !== "string" || !title || title.length > 100 || title.includes("'")) throw new PublicError("В таблице распределения нет листа.");
  return sheet(spreadsheetId, title, "AZ", true);
}
