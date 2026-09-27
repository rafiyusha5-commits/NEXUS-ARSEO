"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";
import { type Issue, normalizePackage } from "@/lib/reference-import/package.ts";
import { type ImportReport, parseReport } from "@/lib/reference-import/report.ts";

export type ReferenceImportResult =
  | { ok: true; report: ImportReport }
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
      : error.message;
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
