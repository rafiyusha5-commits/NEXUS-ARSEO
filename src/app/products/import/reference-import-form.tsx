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
import { type GoogleCalculatorImportResult, type ReferenceImportResult, runGoogleCalculatorImport, runReferenceImport } from "./actions";
import { isCalculatorSheet } from "@/lib/calculator-import/parser.ts";
import { CalculatorSchemaReviewPanel } from "./calculator-schema-review";
import type { CalculatorQualityIssue } from "@/lib/calculator-import/quality.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PAYLOAD_CHARS = 4_000_000;
const SHOWN_ROWS = 300;

type Loaded = { files: string[]; pkg: ReferencePackage | null; payload: string; issues: Issue[] };

async function readFiles(files: File[]): Promise<Loaded> {
  const names = files.map((file) => file.name);
  const fail = (message: string): Loaded => ({ files: names, pkg: null, payload: "", issues: [{ source: "Файлы", row: null, message }] });
  if (files.some((file) => file.size > MAX_FILE_BYTES)) return fail("Файл больше 10 МБ. Разделите данные на несколько файлов.");

  let built: { pkg: ReferencePackage; issues: Issue[] } = {
    pkg: { format: "nexus-reference-import", version: 1, counterparties: [], products: [] },
    issues: [],
  };
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
          if (isCalculatorSheet(sheet.sheet)) {
            return fail("Мастер-калькулятор больше не загружается из XLSX. Используйте защищённый источник Google Sheets выше.");
          }
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
      {report.purchasePrices && <p>Закупочные цены: {report.purchasePrices.applied ? "перенесено" : "к переносу"} {report.purchasePrices.summary.update}, совпадает {report.purchasePrices.summary.unchanged}, требуют проверки {report.purchasePrices.summary.skipped}.</p>}
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

function skippedRowCount(issues: Issue[]) {
  return new Set(issues.flatMap((issue) => issue.row === null ? [] : [issue.row])).size;
}

function SkippedCalculatorRows({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <div className="import-table-wrap">
      <div className="login-error admin-message">
        Пропущено строк: {skippedRowCount(issues)}. Остальные корректные позиции можно синхронизировать.
      </div>
      <table className="import-table">
        <thead><tr><th>Строка</th><th>Причина пропуска</th></tr></thead>
        <tbody>
          {issues.map((issue, index) => (
            <tr className="has-error" key={`${issue.row}-${index}`}><td>{issue.row ?? "—"}</td><td>{issue.message}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalculatorQualityRows({ issues }: { issues: CalculatorQualityIssue[] }) {
  if (!issues.length) return <div className="login-success admin-message">Проверка упаковки: нелогичных соотношений и весов не найдено.</div>;
  return (
    <div className="import-table-wrap">
      <div className="admin-message">Проверка упаковки: замечаний {issues.length}. Они не блокируют синхронизацию и требуют проверки исходных данных.</div>
      <table className="import-table">
        <thead><tr><th>Строка</th><th>Артикул</th><th>Проверка</th><th>Замечание</th></tr></thead>
        <tbody>{issues.map((issue, index) => (
          <tr key={`${issue.sku}-${issue.kind}-${index}`}><td>{issue.row ?? "—"}</td><td>{issue.sku}</td><td>{issue.kind === "missing" ? "Не заполнено" : issue.kind === "quantity" ? "Количество" : "Вес"}</td><td>{issue.message}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function ReferenceImportForm() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<{ mode: "preview" | "apply"; payload: string; value: ReferenceImportResult } | null>(null);
  const [googleResult, setGoogleResult] = useState<{ mode: "preview" | "apply"; value: GoogleCalculatorImportResult } | null>(null);
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

  function runGoogle(mode: "preview" | "apply" | "approve-schema") {
    const value = googleResult?.value;
    const snapshot = value?.snapshot;
    const expectedSchema = value && !value.ok ? value.schemaReview?.expected_schema ?? undefined : undefined;
    const resultMode = mode === "apply" ? "apply" : "preview";
    startTransition(async () => {
      try {
        setGoogleResult({ mode: resultMode, value: await runGoogleCalculatorImport(mode, snapshot, expectedSchema) });
      } catch {
        setGoogleResult({ mode: resultMode, value: { ok: false, message: "Сервер не ответил. Попробуйте ещё раз." } });
      }
    });
  }

  const stats = loaded?.pkg ? packageStats(loaded.pkg) : null;
  const ready = Boolean(loaded?.pkg && loaded.payload && !loaded.issues.length);
  const preview = result?.mode === "preview" && result.payload === loaded?.payload && result.value.ok ? result.value.report : null;
  const canApply = Boolean(ready && preview && !hasProblems(preview) && hasChanges(preview));
  const applied = result?.mode === "apply" && result.value.ok ? result.value.report : null;
  const failure = result && !result.value.ok ? result.value : null;
  const googlePreview = googleResult?.mode === "preview" && googleResult.value.ok ? googleResult.value : null;
  const googleApplied = googleResult?.mode === "apply" && googleResult.value.ok ? googleResult.value : null;
  const googleFailure = googleResult && !googleResult.value.ok ? googleResult.value : null;
  // Applying an unchanged reference report is still useful: it refreshes the
  // calculator field descriptions and complete source data stored by Nexus.
  const googleCanApply = Boolean(googlePreview && !hasProblems(googlePreview.report));

  return (
    <>
      <section className="panel admin-section import-drop">
        <div>
          <p className="eyebrow">Основной источник · Google Sheets</p>
          <h2>Мастер-калькулятор ARSEO</h2>
          <p>Книга «01 мастер калькулятор KZ», лист «расчеты». Nexus использует строки 3–5 как устойчивую схему полей и никогда не изменяет Google Таблицу.</p>
          <p className="form-help">Подключение работает только через служебный аккаунт с правом Viewer и OAuth-разрешением spreadsheets.readonly.</p>
        </div>
        <div className="import-actions">
          <button className="primary" type="button" disabled={pending} onClick={() => runGoogle("preview")}>
            {pending && !result ? "Чтение…" : "Прочитать и проверить"}
          </button>
        </div>
      </section>

      {googleFailure && (
        <section className="panel admin-section">
          <div className="login-error admin-message">{googleFailure.message}</div>
          {googleFailure.issues?.map((issue, index) => <p className="form-help" key={index}>{issue.source}, строка {issue.row ?? "—"}: {issue.message}</p>)}
          {googleFailure.schemaApproved && <p>Новая структура сохранена в истории Nexus. Товары не изменены; повторите проверку товаров.</p>}
          {googleFailure.schemaReview && <CalculatorSchemaReviewPanel key={`${googleFailure.snapshot}-${googleFailure.schemaReview.expected_schema}`} review={googleFailure.schemaReview} pending={pending} onConfirm={() => runGoogle("approve-schema")} />}
          {googleFailure.report && <ReportView key="google-failure" report={googleFailure.report} />}
        </section>
      )}

      {googlePreview && !googleApplied && (
        <section className="panel admin-section">
          <div className="panel-heading">
            <div><p className="eyebrow">Google Sheets · предпросмотр товаров · товары ещё не изменены</p><h2>{googlePreview.source.products} товаров · {googlePreview.source.columns} полей</h2><p className="form-help">Лист «{googlePreview.source.sheet}» · прочитано строк: {googlePreview.source.rows}</p></div>
            <span className={hasProblems(googlePreview.report) ? "import-invalid" : "import-valid"}>{hasProblems(googlePreview.report) ? "Есть конфликты" : googlePreview.skippedIssues.length ? `Готово · пропущено строк: ${skippedRowCount(googlePreview.skippedIssues)}` : hasChanges(googlePreview.report) ? "Готово к синхронизации" : "Данные актуальны · можно обновить поля"}</span>
          </div>
          {googlePreview.schemaApproved && <p className="login-success admin-message">Новая структура подтверждена и сохранена в истории. Проверьте результат ниже; запись товаров выполняется отдельной кнопкой.</p>}
          <SkippedCalculatorRows issues={googlePreview.skippedIssues} />
          <CalculatorQualityRows issues={googlePreview.qualityIssues} />
          <ReportView key={`google-preview-${googlePreview.snapshot}`} report={googlePreview.report} />
          <div className="import-confirm">
            <button className="primary" type="button" disabled={!googleCanApply || pending} onClick={() => runGoogle("apply")}>Синхронизировать с Nexus</button>
            <span>Перед записью Nexus повторно прочитает источник. Если таблица изменилась после проверки, синхронизация остановится.</span>
          </div>
        </section>
      )}

      {googleApplied && (
        <section className="panel admin-section">
          <div className="login-success admin-message">Google Таблица синхронизирована: создано {googleApplied.report.summary.create}, обновлено {googleApplied.report.summary.update}, без изменений {googleApplied.report.summary.unchanged}, пропущено строк {skippedRowCount(googleApplied.skippedIssues)}. <Link href="/products">Открыть товары</Link></div>
          <SkippedCalculatorRows issues={googleApplied.skippedIssues} />
          <CalculatorQualityRows issues={googleApplied.qualityIssues} />
          <ReportView key={`google-applied-${googleApplied.snapshot}`} report={googleApplied.report} />
        </section>
      )}

      <section className="panel admin-section import-drop">
        <div>
          <p className="eyebrow">Дополнительные справочники · JSON / CSV / Excel</p>
          <h2>Загрузить отдельные справочные данные</h2>
          <p>
            Здесь принимаются контрагенты, товары, идентификаторы и упаковка. Мастер-калькулятор читается только из закреплённой Google Таблицы выше.
            Цены в обычных справочных файлах отклоняются.
          </p>
          <p className="ri-templates">
            Шаблоны: <Link href="/products/import/template?kind=counterparties">контрагенты</Link> · <Link href="/products/import/template?kind=products">товары</Link> ·{" "}
            <Link href="/products/import/template?kind=identifiers">идентификаторы</Link> · <Link href="/products/import/template?kind=packaging">упаковка</Link> ·{" "}
            <Link href="/products/import/template?kind=json">JSON</Link>
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
