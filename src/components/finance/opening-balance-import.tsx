"use client";

import { useRef, useState } from "react";
import { readSheet } from "read-excel-file/browser";
import { ImportReview } from "@/components/finance/import-review";
import { decodeStatement } from "@/lib/finance/bank-statement";
import { parseCsv, parseOpeningBalances, type Cell, type ParsedOpening } from "@/lib/finance/opening-balances";
import { money } from "@/lib/finance/receivables";

// The 1С report is read in the browser; the rows are shown before anything is saved.
export function OpeningBalanceImport({ today }: { today: string }) {
  const [parsed, setParsed] = useState<ParsedOpening | null>(null);
  const [fileName, setFileName] = useState("");
  const [problem, setProblem] = useState("");
  const [asOf, setAsOf] = useState("");
  const [sha, setSha] = useState("");
  const loadSequence = useRef(0);
  async function load(file?: File) {
    const sequence = ++loadSequence.current;
    setParsed(null); setProblem(""); setFileName(file?.name ?? "");
    if (!file) return;
    try {
      if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error("Поддерживаются только XLSX и CSV.");
      const bytes = await file.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b => b.toString(16).padStart(2,"0")).join("");
      const matrix = file.name.toLowerCase().endsWith(".xlsx") ? (await readSheet(file)) as unknown as Cell[][] : parseCsv(decodeStatement(new Uint8Array(bytes)));
      if (sequence !== loadSequence.current) return;
      setSha(hash);
      setParsed(parseOpeningBalances(matrix));
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setProblem(error instanceof Error ? error.message : "Не удалось прочитать файл.");
    }
  }
  const totals = new Map<string, number>();
  for (const row of parsed?.rows ?? []) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
  return <div className="bank-import">
    <div className="reference-form">
      <label>Дата сальдо из отчёта (укажите явно)<input name="as_of" type="date" required max={today} value={asOf} onChange={e => setAsOf(e.target.value)}/></label>
      <label className="wide-field">Отчёт 1С по взаиморасчётам (XLSX или CSV)<input type="file" accept=".xlsx,.csv,text/csv" onChange={event => load(event.target.files?.[0])}/></label>
    </div>
    <p className="form-help">Поддерживается плоский отчёт: одна строка на покупателя и валюту. Иерархию итогов и договоров необходимо свернуть в 1С явно. Замена действующего сальдо требует проверки конфликта и причины. Правила учёта оплат и отгрузок не изменяются.</p>
    {problem && <div className="login-error admin-message">{problem}</div>}
    {parsed && <>
      <div className="operation-facts"><div><small>Строк</small><strong>{parsed.rows.length}</strong></div>{[...totals].map(([currency, sum]) => <div key={currency}><small>Итого {currency}</small><strong>{money(sum, currency)}</strong></div>)}</div>
      {parsed.problems.length > 0 && <div className="setup-notice">Пропущены: {parsed.problems.slice(0, 5).join("; ")}{parsed.problems.length > 5 ? "…" : ""}</div>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Строка</th><th>Контрагент</th><th>БИН</th><th>Договор</th><th>Сальдо</th></tr></thead><tbody>
        {parsed.rows.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.name}</td><td>{row.bin ?? "—"}</td><td>{row.contract ?? "—"}</td><td>{money(row.amount, row.currency)}</td></tr>)}
      </tbody></table></div>
      {parsed.excluded.map(row => <p key={row.rowNumber}>Строка {row.rowNumber}, {row.name}: исключена — {row.reason}.</p>)}
      <input type="hidden" name="file_name" value={fileName}/>
      <input type="hidden" name="rows" value={JSON.stringify(parsed.rows.map(({ name, bin, contract, currency, amount, due_date }) => ({ name, bin, contract, currency, amount, due_date })))}/>
      {parsed.rows.length > 0 && asOf && <ImportReview key={`${sha}:${asOf}`} payload={{kind:"opening",file_name:fileName,file_sha256:sha,as_of:asOf,rows:parsed.rows.map(row => ({...row})),problems:parsed.problems,excluded:parsed.excluded}}/>}
    </>}
  </div>;
}
