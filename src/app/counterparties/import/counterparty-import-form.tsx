"use client";

import { useMemo, useState } from "react";
import readXlsxFile from "read-excel-file/browser";
import { importCounterparties } from "./actions";

type Cell = string | number | boolean | Date | null;
type PreparedRow = {
  rowNumber: number; legalName: string; shortName: string; roles: string[]; country: string; taxId: string;
  registrationNumber: string; website: string; defaultCurrency: string; preferredLocale: string;
  minShelfLifePct: number | null; notes: string; errors: string[];
};

const roleLabels: Record<string, string> = {
  manufacturer: "Производитель", supplier: "Поставщик", customer: "Клиент", carrier: "Перевозчик",
  broker: "Брокер", printing_house: "Типография", other: "Другое",
};
const roleAliases: Record<string, string> = {
  manufacturer: "manufacturer", "производитель": "manufacturer", supplier: "supplier", "поставщик": "supplier",
  customer: "customer", "клиент": "customer", carrier: "carrier", "перевозчик": "carrier", broker: "broker",
  "брокер": "broker", printing_house: "printing_house", "типография": "printing_house", other: "other", "другое": "other",
};
const aliases: Record<string, string[]> = {
  legalName: ["legal_name", "юридическое название", "юр название"], shortName: ["short_name", "короткое название"],
  roles: ["roles", "типы", "тип"], country: ["country", "страна"], taxId: ["tax_id", "бин", "инн", "vat", "бин / инн / vat"],
  registrationNumber: ["registration_number", "регистрационный номер"], website: ["website", "сайт"],
  defaultCurrency: ["default_currency", "валюта"], preferredLocale: ["preferred_locale", "язык"],
  minShelfLifePct: ["min_shelf_life_pct", "мин. осг, %", "минимальный осг"], notes: ["notes", "примечание", "комментарий"],
};
const normalize = (value: Cell) => String(value ?? "").trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
const text = (value: Cell) => String(value ?? "").trim();

function parseCsv(source: string): Cell[][] {
  const rows: Cell[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < source.length; i++) { const char = source[i]; if (char === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if ((char === "," || char === ";" || char === "\t") && !quoted) { row.push(cell); cell = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && source[i + 1] === "\n") i++; row.push(cell); if (row.some((value) => value.trim())) rows.push(row); row = []; cell = ""; } else cell += char; }
  row.push(cell); if (row.some((value) => value.trim())) rows.push(row); return rows;
}

export function CounterpartyImportForm() {
  const [rows, setRows] = useState<PreparedRow[]>([]); const [fileName, setFileName] = useState(""); const [fileError, setFileError] = useState("");
  const valid = rows.length > 0 && rows.every((row) => row.errors.length === 0); const payload = useMemo(() => JSON.stringify(rows), [rows]);
  async function load(file?: File) {
    if (!file) return; setFileError(""); setFileName(file.name);
    try {
      let matrix: Cell[][]; if (file.name.toLowerCase().endsWith(".xlsx")) matrix = (await readXlsxFile(file)) as unknown as Cell[][]; else matrix = parseCsv(await file.text());
      if (matrix.length < 2) throw new Error("В файле нет строк с контрагентами.");
      const headers = matrix[0].map(normalize); const column = (key: string) => headers.findIndex((header) => aliases[key].includes(header));
      const indexes = Object.fromEntries(Object.keys(aliases).map((key) => [key, column(key)]));
      if (indexes.legalName < 0 || indexes.roles < 0 || indexes.country < 0) throw new Error("Не найдены обязательные колонки: legal_name, roles, country.");
      const prepared = matrix.slice(1).filter((row) => row.some((value) => text(value))).map((row, index) => {
        const get = (key: string) => indexes[key] >= 0 ? row[indexes[key]] : null;
        const rawRoles = text(get("roles")).split(/[|;,]/).map(normalize).filter(Boolean); const parsedRoles = rawRoles.map((role) => roleAliases[role]).filter(Boolean);
        const shelfRaw = text(get("minShelfLifePct"));
        const item: PreparedRow = { rowNumber: index + 2, legalName: text(get("legalName")), shortName: text(get("shortName")), roles: [...new Set(parsedRoles)], country: text(get("country")).toUpperCase(), taxId: text(get("taxId")), registrationNumber: text(get("registrationNumber")), website: text(get("website")), defaultCurrency: text(get("defaultCurrency")).toUpperCase(), preferredLocale: normalize(get("preferredLocale")) || "ru", minShelfLifePct: shelfRaw ? Number(shelfRaw) : null, notes: text(get("notes")), errors: [] };
        if (!item.legalName) item.errors.push("Нет юридического названия"); if (!item.roles.length || parsedRoles.length !== rawRoles.length) item.errors.push("Неизвестный тип"); if (!/^[A-Z]{2}$/.test(item.country)) item.errors.push("Страна: нужен код из 2 букв"); if (item.defaultCurrency && !/^[A-Z]{3}$/.test(item.defaultCurrency)) item.errors.push("Валюта: нужен код из 3 букв"); if (!['ru', 'kk', 'en'].includes(item.preferredLocale)) item.errors.push("Язык: ru, kk или en"); if (item.minShelfLifePct !== null && (!Number.isFinite(item.minShelfLifePct) || item.minShelfLifePct < 0 || item.minShelfLifePct > 100)) item.errors.push("ОСГ: число от 0 до 100");
        return item;
      });
      if (prepared.length > 500) throw new Error("В одном файле допускается не более 500 строк."); setRows(prepared);
    } catch (error) { setRows([]); setFileError(error instanceof Error ? error.message : "Не удалось прочитать файл."); }
  }
  return <><section className="panel admin-section import-drop"><div><p className="eyebrow">Excel / CSV</p><h2>Выберите файл</h2><p>Обязательные колонки: legal_name, roles, country. Несколько типов разделяйте знаком |.</p></div><div className="import-actions"><a className="ghost button-link" href="/counterparties/import/template">Скачать шаблон CSV</a><label className="primary file-button">Выбрать файл<input type="file" accept=".xlsx,.csv,.tsv,text/csv" onChange={(event) => load(event.target.files?.[0])} /></label></div></section>{fileError && <div className="login-error admin-message">{fileError}</div>}{rows.length > 0 && <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Предпросмотр · {fileName}</p><h2>{rows.length} строк</h2></div><span className={valid ? "import-valid" : "import-invalid"}>{valid ? "Готово к импорту" : `${rows.filter((row) => row.errors.length).length} строк с ошибками`}</span></div><div className="import-table-wrap"><table className="import-table"><thead><tr><th>Строка</th><th>Юридическое название</th><th>Типы</th><th>Страна</th><th>БИН / ИНН / VAT</th><th>Валюта</th><th>Проверка</th></tr></thead><tbody>{rows.slice(0, 100).map((row) => <tr className={row.errors.length ? "has-error" : ""} key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.legalName || "—"}</td><td>{row.roles.map((role) => roleLabels[role] ?? role).join(", ") || "—"}</td><td>{row.country || "—"}</td><td>{row.taxId || "—"}</td><td>{row.defaultCurrency || "—"}</td><td>{row.errors.length ? row.errors.join("; ") : "Корректно"}</td></tr>)}</tbody></table></div>{rows.length > 100 && <p className="form-help">Показаны первые 100 строк из {rows.length}.</p>}<form action={importCounterparties} className="import-confirm"><input type="hidden" name="rows_json" value={payload} /><button className="primary" type="submit" disabled={!valid}>Подтвердить импорт</button><span>Записи будут добавлены только после подтверждения.</span></form></section>}</>;
}
