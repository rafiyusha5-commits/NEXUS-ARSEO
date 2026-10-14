"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { selectAll } from "@/lib/supabase/select-all";

const allowedRoles = new Set(["manufacturer", "supplier", "customer", "carrier", "broker", "printing_house", "other"]);
const allowedLocales = new Set(["ru", "kk", "en"]);

type ImportRow = {
  legalName: string;
  shortName?: string;
  roles: string[];
  country: string;
  taxId?: string;
  registrationNumber?: string;
  website?: string;
  defaultCurrency?: string;
  preferredLocale?: string;
  minShelfLifePct?: number | null;
  notes?: string;
};

function go(kind: "error" | "success", message: string): never {
  redirect(`/counterparties/import?${kind}=${encodeURIComponent(message)}`);
}

export async function importCounterparties(formData: FormData) {
  const { supabase } = await requireUser();
  let rows: ImportRow[];
  try {
    rows = JSON.parse(String(formData.get("rows_json") ?? "[]"));
  } catch {
    go("error", "Не удалось прочитать подготовленные строки.");
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) go("error", "За один раз можно импортировать от 1 до 500 строк.");

  const cleaned = rows.map((row) => ({
    ...row,
    legalName: String(row.legalName ?? "").trim(),
    shortName: String(row.shortName ?? "").trim(),
    roles: Array.isArray(row.roles) ? [...new Set(row.roles.map(String))] : [],
    country: String(row.country ?? "").trim().toUpperCase(),
    taxId: String(row.taxId ?? "").trim(),
    defaultCurrency: String(row.defaultCurrency ?? "").trim().toUpperCase(),
    preferredLocale: String(row.preferredLocale ?? "ru").trim().toLowerCase(),
  }));
  if (cleaned.some((row) => !row.legalName || !/^[A-Z]{2}$/.test(row.country) || !row.roles.length || row.roles.some((role) => !allowedRoles.has(role)) || !allowedLocales.has(row.preferredLocale))) {
    go("error", "В файле есть строки с некорректным названием, страной, типом или языком.");
  }

  const currencyCodes = [...new Set(cleaned.map((row) => row.defaultCurrency).filter(Boolean))];
  const { data: currencies, error: currencyError } = currencyCodes.length
    ? await supabase.from("currencies").select("id, code").in("code", currencyCodes)
    : { data: [], error: null };
  if (currencyError) go("error", publicErrorMessage(currencyError,"Не удалось проверить справочник валют."));
  const currencyIds = new Map((currencies ?? []).map((currency) => [currency.code, currency.id]));
  const missingCurrency = currencyCodes.find((code) => !currencyIds.has(code));
  if (missingCurrency) go("error", `В справочнике валют нет кода ${missingCurrency}.`);

  const countries = [...new Set(cleaned.map((row) => row.country))];
  const { data: existing, error: existingError } = await selectAll((from, to) => supabase.from("counterparties").select("legal_name, country, tax_id").in("country", countries).order("id").range(from, to));
  if (existingError) go("error", publicErrorMessage(existingError,"Не удалось проверить существующих контрагентов."));
  const existingKeys = new Set((existing ?? []).flatMap((item) => [
    item.tax_id ? `tax:${item.country}:${String(item.tax_id).toLocaleLowerCase("ru-RU")}` : "",
    `name:${item.country}:${item.legal_name.trim().toLocaleLowerCase("ru-RU")}`,
  ]).filter(Boolean));
  const seen = new Set<string>();
  const uniqueRows = cleaned.filter((row) => {
    const taxKey = row.taxId ? `tax:${row.country}:${row.taxId.toLocaleLowerCase("ru-RU")}` : "";
    const nameKey = `name:${row.country}:${row.legalName.toLocaleLowerCase("ru-RU")}`;
    if (existingKeys.has(nameKey) || (taxKey && existingKeys.has(taxKey)) || seen.has(nameKey) || (taxKey && seen.has(taxKey))) return false;
    seen.add(nameKey);
    if (taxKey) seen.add(taxKey);
    return true;
  });
  const skipped = cleaned.length - uniqueRows.length;
  if (!uniqueRows.length) go("error", "Все строки пропущены: такие контрагенты уже существуют или повторяются в файле.");

  const { data: inserted, error } = await supabase.from("counterparties").insert(uniqueRows.map((row) => ({
    legal_name: row.legalName,
    short_name: row.shortName || null,
    roles: row.roles,
    country: row.country,
    tax_id: row.taxId || null,
    registration_number: String(row.registrationNumber ?? "").trim() || null,
    website: String(row.website ?? "").trim() || null,
    default_currency_id: row.defaultCurrency ? currencyIds.get(row.defaultCurrency) : null,
    preferred_locale: row.preferredLocale,
    min_remaining_shelf_life_pct: row.minShelfLifePct ?? null,
    notes: String(row.notes ?? "").trim() || null,
    status: "active",
  }))).select("id");
  if (error || !inserted) go("error", publicErrorMessage(error,"Не удалось импортировать контрагентов."));

  revalidatePath("/counterparties");
  go("success", `Импортировано контрагентов: ${inserted.length}${skipped ? `. Пропущено дублей: ${skipped}` : ""}.`);
}
