"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import readXlsxFile from "read-excel-file/browser";
import type { Cell } from "@/lib/reference-import/normalize.ts";
import { type Issue, type ReferencePackage, normalizePackage, packageStats } from "@/lib/reference-import/package.ts";
import {
  type ImportReport,
  type ImportStatus,
  IMPORT_STATUSES,
  entityLabel,
  fieldLabel,
  hasChanges,
  hasProblems,
  sortReportItems,
  statusLabel,
} from "@/lib/reference-import/report.ts";
import { type Table, buildPackageFromTables, parseCsv } from "@/lib/reference-import/tables.ts";
import { type ReferenceImportResult, runReferenceImport } from "./actions";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PAYLOAD_CHARS = 4_000_000;
const SHOWN_ROWS = 300;

type Loaded = { files: string[]; pkg: ReferencePackage | null; payload: string; issues: Issue[] };

async function readFiles(files: File[]): Promise<Loaded> {
  const names = files.map((file) => file.name);
  const fail = (message: string): Loaded => ({ files: names, pkg: null, payload: "", issues: [{ source: "Файлы", row: null, message }] });
  if (files.some((file) => file.size > MAX_FILE_BYTES)) return fail("Файл больше 10 МБ. Разделите данные на несколько файлов.");

  let built: { pkg: ReferencePackage; issues: Issue[] };
  const json = files.filter((file) => /\.json$/i.test(file.name));
  if (json.length) {
    if (files.length > 1) return fail("JSON-пакет загружается отдельно, без других файлов.");
    let raw: unknown;
    try {
      raw = JSON.parse(await json[0].text());
    } catch {
      return fail(`${json[0].name}: файл не является корректным JSON.`);
    }
    built = normalizePackage(raw, json[0].name);
  } else {
    const tables: Table[] = [];
    for (const file of files) {
      if (/\.xlsx$/i.test(file.name)) {
        for (const sheet of await readXlsxFile(file)) {
          const rows = sheet.data as unknown as Cell[][];
          if (rows.some((row) => row.some((value) => value !== null && String(value).trim() !== ""))) {
            tables.push({ source: `${file.name} · ${sheet.sheet}`, rows });
          }
        }
      } else if (/\.(csv|tsv|txt)$/i.test(file.name)) {
        tables.push({ source: file.name, rows: parseCsv(await file.text()) });
      } else {
        return fail(`${file.name}: поддерживаются .json, .csv, .tsv и .xlsx.`);
      }
    }
    built = buildPackageFromTables(tables);
  }
  const payload = JSON.stringify(built.pkg);
  if (payload.length > MAX_PAYLOAD_CHARS) built.issues.push({ source: "Пакет", row: null, message: "Пакет больше 4 МБ. Разделите файл на части." });
  return { files: names, pkg: built.pkg, payload, issues: built.issues };
}

function ReportView({ report }: { report: ImportReport }) {
  const [filter, setFilter] = useState<ImportStatus | "all">(hasProblems(report) ? "conflict" : "all");
  const items = useMemo(() => {
    const sorted = sortReportItems(report.items);
    if (filter === "all") return sorted;
    if (filter === "conflict" || filter === "error") return sorted.filter((item) => item.status === "conflict" || item.status === "error");
    return sorted.filter((item) => item.status === filter);
  }, [report, filter]);
  return (
    <>
      <div className="ri-summary">
        {IMPORT_STATUSES.map((status) => (
          <span className={`doc-badge ri-${status}`} key={status}>{statusLabel[status]}: {report.summary[status]}</span>
        ))}
      </div>
      <label className="ri-filter">Показать
        <select value={filter} onChange={(event) => setFilter(event.target.value as ImportStatus | "all")}>
          <option value="all">Все строки</option>
          <option value="conflict">Конфликты и ошибки</option>
          <option value="create">Создание</option>
          <option value="update">Обновление</option>
          <option value="unchanged">Без изменений</option>
        </select>
      </label>
      <div className="import-table-wrap">
        <table className="import-table">
          <thead><tr><th>Строка</th><th>Объект</th><th>Ключ</th><th>Действие</th><th>Изменения / причина</th></tr></thead>
          <tbody>
            {items.slice(0, SHOWN_ROWS).map((item, index) => (
              <tr className={item.status === "conflict" || item.status === "error" ? "has-error" : ""} key={`${item.entity}-${item.key}-${index}`}>
                <td>{item.row || "—"}</td>
                <td>{entityLabel[item.entity]}</td>
                <td>{item.key}</td>
                <td><span className={`doc-badge ri-${item.status}`}>{statusLabel[item.status]}</span></td>
                <td>{item.message ?? (item.changes.length ? item.changes.map((field) => fieldLabel[field] ?? field).join(", ") : "—")}</td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={5}>Нет строк с таким статусом.</td></tr>}
          </tbody>
        </table>
      </div>
      {items.length > SHOWN_ROWS && <p className="form-help">Показаны первые {SHOWN_ROWS} строк из {items.length}.</p>}
    </>
  );
}

export function ReferenceImportForm() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<{ mode: "preview" | "apply"; payload: string; value: ReferenceImportResult } | null>(null);
  const [pending, startTransition] = useTransition();

  async function load(list: FileList | null) {
    const files = Array.from(list ?? []);
    setResult(null);
    if (!files.length) return;
    setReading(true);
    try {
      setLoaded(await readFiles(files));
    } catch (error) {
      setLoaded({ files: files.map((file) => file.name), pkg: null, payload: "", issues: [
        { source: "Файлы", row: null, message: error instanceof Error ? error.message : "Не удалось прочитать файл." },
      ] });
    } finally {
      setReading(false);
    }
  }

  function run(mode: "preview" | "apply") {
    if (!loaded?.payload) return;
    const payload = loaded.payload;
    startTransition(async () => {
      try {
        setResult({ mode, payload, value: await runReferenceImport(payload, mode) });
      } catch {
        setResult({ mode, payload, value: { ok: false, message: "Сервер не ответил. Попробуйте ещё раз." } });
      }
    });
  }

  const stats = loaded?.pkg ? packageStats(loaded.pkg) : null;
  const ready = Boolean(loaded?.pkg && loaded.payload && !loaded.issues.length);
  const preview = result?.mode === "preview" && result.payload === loaded?.payload && result.value.ok ? result.value.report : null;
  const canApply = Boolean(ready && preview && !hasProblems(preview) && hasChanges(preview));
  const applied = result?.mode === "apply" && result.value.ok ? result.value.report : null;
  const failure = result && !result.value.ok ? result.value : null;

  return (
    <>
      <section className="panel admin-section import-drop">
        <div>
          <p className="eyebrow">JSON / CSV / Excel</p>
          <h2>Выберите файлы справочника</h2>
          <p>
            Один JSON-пакет или таблицы: контрагенты, товары, идентификаторы, упаковка (можно несколько CSV или листы одного XLSX).
            Цены, себестоимость и условия договоров не загружаются — такие колонки отклоняются. Формат: docs/reference-import.md.
          </p>
          <p className="ri-templates">
            Шаблоны: <a href="/products/import/template?kind=counterparties">контрагенты</a> · <a href="/products/import/template?kind=products">товары</a> ·{" "}
            <a href="/products/import/template?kind=identifiers">идентификаторы</a> · <a href="/products/import/template?kind=packaging">упаковка</a> ·{" "}
            <a href="/products/import/template?kind=json">JSON</a>
          </p>
        </div>
        <div className="import-actions">
          <label className="primary file-button">{reading ? "Чтение…" : "Выбрать файлы"}
            <input type="file" multiple accept=".json,.csv,.tsv,.txt,.xlsx,application/json,text/csv"
              onChange={(event) => { void load(event.target.files); event.target.value = ""; }} />
          </label>
        </div>
      </section>

      {loaded && (
        <section className="panel admin-section">
          <div className="panel-heading">
            <div><p className="eyebrow">Файлы · {loaded.files.join(", ")}</p>
              <h2>{stats ? `${stats.counterparties} контрагентов · ${stats.products} товаров · ${stats.identifiers} идентификаторов · ${stats.packaging} уровней упаковки` : "Файл не прочитан"}</h2>
            </div>
            <span className={loaded.issues.length ? "import-invalid" : "import-valid"}>
              {loaded.issues.length ? `Ошибок в файле: ${loaded.issues.length}` : "Файл прочитан"}
            </span>
          </div>
          {loaded.issues.length > 0 && (
            <div className="import-table-wrap">
              <table className="import-table">
                <thead><tr><th>Источник</th><th>Строка</th><th>Проблема</th></tr></thead>
                <tbody>
                  {loaded.issues.slice(0, SHOWN_ROWS).map((issue, index) => (
                    <tr className="has-error" key={index}><td>{issue.source}</td><td>{issue.row ?? "—"}</td><td>{issue.message}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="import-confirm">
            <button className="primary" type="button" disabled={!ready || pending} onClick={() => run("preview")}>
              {pending && result?.mode !== "apply" ? "Проверка…" : "Проверить без записи"}
            </button>
            <button className="primary" type="button" disabled={!canApply || pending} onClick={() => run("apply")}>
              Импортировать
            </button>
            <span>
              Проверка ничего не записывает. Импорт выполняется одной транзакцией: при любом конфликте или ошибке не сохраняется ни одна строка.
            </span>
          </div>
        </section>
      )}

      {failure && (
        <section className="panel admin-section">
          <div className="login-error admin-message">{failure.message}</div>
          {failure.issues?.map((issue, index) => <p className="form-help" key={index}>{issue.source}, строка {issue.row ?? "—"}: {issue.message}</p>)}
          {failure.report && <ReportView key={`failure-${result?.payload.length}`} report={failure.report} />}
        </section>
      )}

      {preview && !applied && (
        <section className="panel admin-section">
          <div className="panel-heading">
            <div><p className="eyebrow">Предпросмотр · ничего не записано</p><h2>Что изменится</h2></div>
            <span className={hasProblems(preview) ? "import-invalid" : "import-valid"}>
              {hasProblems(preview) ? "Импорт невозможен: исправьте конфликты и ошибки" : hasChanges(preview) ? "Готово к импорту" : "Изменений нет"}
            </span>
          </div>
          <ReportView key={`preview-${result?.payload.length}`} report={preview} />
        </section>
      )}

      {applied && (
        <section className="panel admin-section">
          <div className="login-success admin-message">
            Импорт выполнен: создано {applied.summary.create}, обновлено {applied.summary.update}, без изменений {applied.summary.unchanged}.{" "}
            <Link href="/products">Открыть товары</Link>
          </div>
          <ReportView key="applied" report={applied} />
        </section>
      )}
    </>
  );
}
