"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import {
  CALCULATOR_SHEET_NAME,
  CALCULATOR_SOURCE_TITLE,
  CALCULATOR_SPREADSHEET_ID,
  readCalculatorSheet,
} from "@/lib/google/calculator-sheet";
import { loadPermissions } from "@/lib/permissions.ts";
import { type Issue, normalizePackage } from "@/lib/reference-import/package.ts";
import { type ImportReport, parseReport } from "@/lib/reference-import/report.ts";
import { buildCalculatorPackage, CALCULATOR_FORMAT, CALCULATOR_VERSION, type CalculatorImportPackage } from "@/lib/calculator-import/parser.ts";
import { parsePurchasePriceReport } from "@/lib/calculator-import/purchase-prices.ts";
import { auditCalculatorPackaging, type CalculatorQualityIssue } from "@/lib/calculator-import/quality.ts";

export type ReferenceImportResult =
  | { ok: true; report: ImportReport }
  | { ok: false; message: string; report?: ImportReport; issues?: Issue[] };

export type GoogleCalculatorImportResult =
  | {
      ok: true;
      report: ImportReport;
      snapshot: string;
      skippedIssues: Issue[];
      qualityIssues: CalculatorQualityIssue[];
      source: { title: string; sheet: string; spreadsheetId: string; columns: number; rows: number; products: number };
    }
  | { ok: false; message: string; report?: ImportReport; issues?: Issue[] };

// Stays below serverActions.bodySizeLimit in next.config.ts.
const MAX_PAYLOAD_CHARS = 4_000_000;
const PERMISSIONS = ["products.create", "products.update"] as const;

// Runs the import as the signed-in user: "preview" is a dry-run that writes nothing,
// "apply" writes the whole package in one transaction or nothing at all. The package is
// normalised again here and once more by the database; the payload is never logged
// because the source files may be confidential.
export async function runReferenceImport(payload: string, mode: "preview" | "apply"): Promise<ReferenceImportResult> {
  if (mode !== "preview" && mode !== "apply") return { ok: false, message: "Неизвестный режим импорта." };
  if (typeof payload !== "string" || !payload || payload.length > MAX_PAYLOAD_CHARS) {
    return { ok: false, message: "Пакет пуст или слишком большой. Разделите файл на части." };
  }

  const { supabase } = await requireUser();
  const can = await loadPermissions(supabase, PERMISSIONS);
  if (!can["products.create"] || !can["products.update"]) {
    return { ok: false, message: "Недостаточно прав: для импорта справочника нужны права «Товары: создание» и «Товары: изменение»." };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { ok: false, message: "Не удалось прочитать подготовленный пакет." };
  }
  const { pkg, issues } = normalizePackage(raw, "Пакет");
  if (issues.length) {
    return { ok: false, message: `В пакете есть ошибки (${issues.length}). Исправьте файл и загрузите его снова.`, issues: issues.slice(0, 200) };
  }

  const { data, error } = await supabase.rpc("import_reference_data", { p_payload: pkg, p_dry_run: mode === "preview" });
  if (error) {
    // A cancelled import (NX422) carries its conflicts and errors in the details.
    let report: ImportReport | null = null;
    if (error.code === "NX422" && error.details) {
      try {
        report = parseReport(JSON.parse(error.details));
      } catch {
        report = null;
      }
    }
    const message = /import_reference_data/.test(error.message) && /schema cache|does not exist/.test(error.message)
      ? "Импорт ещё не подключён к базе. Администратору: примените миграцию 202609271900_reference_data_import.sql."
      : publicErrorMessage(error,"Не удалось обработать импорт справочника.");
    return { ok: false, message, ...(report ? { report } : {}) };
  }

  const report = parseReport(data);
  if (!report) return { ok: false, message: "База данных вернула неожиданный ответ." };
  if (mode === "apply") {
    revalidatePath("/products");
    revalidatePath("/counterparties");
  }
  return { ok: true, report };
}

export async function runCalculatorImport(payload: string, mode: "preview" | "apply"): Promise<ReferenceImportResult> {
  if (mode !== "preview" && mode !== "apply") return { ok: false, message: "Неизвестный режим импорта." };
  if (typeof payload !== "string" || !payload || payload.length > MAX_PAYLOAD_CHARS) {
    return { ok: false, message: "Пакет пуст или слишком большой. Разделите файл на части." };
  }
  const { supabase } = await requireUser();
  const can = await loadPermissions(supabase, [...PERMISSIONS, "prices.purchase.view"]);
  if (!can["products.create"] || !can["products.update"]) return { ok: false, message: "Недостаточно прав для импорта справочника." };
  if (!can["prices.purchase.view"]) return { ok: false, message: "Калькулятор содержит закупочные цены и расчётные данные. Нужно право «Закупочные цены и себестоимость»." };

  let raw: CalculatorImportPackage;
  try { raw = JSON.parse(payload) as CalculatorImportPackage; } catch { return { ok: false, message: "Не удалось прочитать пакет калькулятора." }; }
  if (raw?.format !== CALCULATOR_FORMAT || raw?.version !== CALCULATOR_VERSION || !raw.reference || !raw.source) {
    return { ok: false, message: "Неверный формат пакета калькулятора." };
  }
  const normalized = normalizePackage(raw.reference, "Калькулятор");
  if (normalized.issues.length) return { ok: false, message: `В справочных данных есть ошибки (${normalized.issues.length}).`, issues: normalized.issues.slice(0, 200) };
  raw.reference = normalized.pkg;

  const { data, error } = await supabase.rpc("import_calculator_master_data", { p_payload: raw, p_dry_run: mode === "preview" });
  if (error) {
    let report: ImportReport | null = null;
    if (error.code === "NX422" && error.details) {
      try { report = parseReport(JSON.parse(error.details)); } catch { report = null; }
    }
    const message = /import_calculator_master_data/.test(error.message) && /schema cache|does not exist/.test(error.message)
      ? "Импорт калькулятора ещё не подключён к базе. Администратору: примените миграцию 202609274300_calculator_master_data.sql."
      : publicErrorMessage(error, "Не удалось обработать мастер-калькулятор.");
    return { ok: false, message, ...(report ? { report } : {}) };
  }
  const report = parseReport(data);
  if (!report) return { ok: false, message: "База данных вернула неожиданный ответ." };
  if (mode === "apply") { revalidatePath("/products"); revalidatePath("/counterparties"); }
  return { ok: true, report };
}

// Reads the one approved Google Sheet through the Sheets values API. The service
// account requests only spreadsheets.readonly; this action has no Google write path.
// Apply re-reads the sheet and requires the exact snapshot shown in preview, so a
// concurrent source change can never be imported without a new dry-run.
export async function runGoogleCalculatorImport(
  mode: "preview" | "apply",
  expectedSnapshot?: string,
): Promise<GoogleCalculatorImportResult> {
  if (mode !== "preview" && mode !== "apply") return { ok: false, message: "Неизвестный режим импорта." };
  const { supabase } = await requireUser();
  const can = await loadPermissions(supabase, [...PERMISSIONS, "prices.purchase.view"]);
  if (!can["products.create"] || !can["products.update"]) return { ok: false, message: "Недостаточно прав для импорта справочника." };
  if (!can["prices.purchase.view"]) return { ok: false, message: "Калькулятор содержит закупочные цены и расчётные данные. Нужно право «Закупочные цены и себестоимость»." };

  try {
    const rows = await readCalculatorSheet();
    const parsed = buildCalculatorPackage(rows, CALCULATOR_SOURCE_TITLE, CALCULATOR_SHEET_NAME);
    const fatalIssues = parsed.issues.filter((issue) => issue.row === null || issue.row <= 5);
    const skippedIssues = parsed.issues.filter((issue) => issue.row !== null && issue.row > 5);
    const qualityIssues = auditCalculatorPackaging(parsed.pkg);
    if (fatalIssues.length) {
      return {
        ok: false,
        message: `Нарушена структура Google Таблицы (${fatalIssues.length}). Данные в Nexus не записаны.`,
        issues: fatalIssues.slice(0, 200),
      };
    }
    const payload = JSON.stringify(parsed.pkg);
    if (payload.length > MAX_PAYLOAD_CHARS) return { ok: false, message: "Пакет Google Таблицы слишком большой для безопасной синхронизации." };
    const snapshot = createHash("sha256").update(payload).digest("hex");
    if (mode === "apply" && (!expectedSnapshot || !/^[a-f0-9]{64}$/.test(expectedSnapshot) || expectedSnapshot !== snapshot)) {
      return { ok: false, message: "Google Таблица изменилась после проверки. Выполните проверку без записи ещё раз." };
    }
    const result = await runCalculatorImport(payload, mode);
    if (!result.ok) return result;
    return {
      ...result,
      snapshot,
      skippedIssues: skippedIssues.slice(0, 200),
      qualityIssues: qualityIssues.slice(0, 300),
      source: {
        title: CALCULATOR_SOURCE_TITLE,
        sheet: CALCULATOR_SHEET_NAME,
        spreadsheetId: CALCULATOR_SPREADSHEET_ID,
        columns: parsed.pkg.source.columns.length,
        rows: rows.length,
        products: parsed.pkg.reference.products.length,
      },
    };
  } catch (error) {
    return { ok: false, message: publicErrorMessage(error, "Не удалось прочитать мастер-калькулятор из Google Sheets.") };
  }
}

export async function syncCalculatorPurchasePrices(currency: string,mode: "preview"|"apply",snapshot?: string) {
 if(!/^[A-Z]{3}$/.test(currency) || !["preview","apply"].includes(mode) || (mode==="apply"&&!/^[a-f0-9]{64}$/.test(snapshot??""))) return {ok:false as const,message:"Выберите валюту и сначала проверьте перенос цен."};
 const {supabase}=await requireUser();
 const can=await loadPermissions(supabase,["products.update","prices.purchase.view"] as const);
 if(!can["products.update"]||!can["prices.purchase.view"])return {ok:false as const,message:"Нужны права на изменение товаров и закупочные цены."};
 const {data,error}=await supabase.rpc("sync_calculator_purchase_prices",{p_currency_code:currency,p_dry_run:mode==="preview",p_expected_hash:snapshot??null});
 if(error)return {ok:false as const,message:publicErrorMessage(error,"Не удалось перенести цены. Проверьте подключение и повторите предпросмотр.")};
 const report=parsePurchasePriceReport(data);if(!report)return {ok:false as const,message:"Не удалось прочитать результат проверки цен."};
 if(mode==="apply")revalidatePath("/products","layout");
 return {ok:true as const,report};
}