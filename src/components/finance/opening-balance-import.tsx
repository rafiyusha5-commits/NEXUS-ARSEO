"use client";

import { useState } from "react";
import { readSheet } from "read-excel-file/browser";
import { importOpeningBalancesAction } from "@/app/finance/receivables/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { parseCsv, parseOpeningBalances, type Cell, type ParsedOpening } from "@/lib/finance/opening-balances";
import { money } from "@/lib/finance/receivables";

// The 1С report is read in the browser; the rows are shown before anything is saved.
export function OpeningBalanceImport({ today }: { today: string }) {
  const [parsed, setParsed] = useState<ParsedOpening | null>(null);
  const [fileName, setFileName] = useState("");
  const [problem, setProblem] = useState("");
  async function load(file?: File) {
    setParsed(null); setProblem(""); setFileName(file?.name ?? "");
    if (!file) return;
    try {
      const matrix = file.name.toLowerCase().endsWith(".xlsx") ? (await readSheet(file)) as unknown as Cell[][] : parseCsv(await file.text());
      setParsed(parseOpeningBalances(matrix));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Не удалось прочитать файл.");
    }
  }
  const totals = new Map<string, number>();
  for (const row of parsed?.rows ?? []) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
  return <form action={importOpeningBalancesAction} className="bank-import">
    <div className="reference-form">
      <label>Сальдо на дату<input name="as_of" type="date" required max={today} defaultValue={today}/></label>
      <label className="wide-field">Отчёт 1С по взаиморасчётам (XLSX или CSV)<input type="file" accept=".xlsx,.csv,text/csv" onChange={event => load(event.target.files?.[0])}/></label>
    </div>
    <p className="form-help">Нужны колонки «Контрагент», желательно «БИН», и сумма: «Сальдо» (плюс — покупатель должен, минус — аванс) или «Дебет»/«Кредит» на конец периода. Покупатель ищется по БИН, затем по точному названию. Новая загрузка заменяет прежнее сальдо покупателя; оплаты и отгрузки до этой даты уже входят в сальдо и не учитываются повторно.</p>
    {problem && <div className="login-error admin-message">{problem}</div>}
    {parsed && <>
      <div className="operation-facts"><div><small>Строк</small><strong>{parsed.rows.length}</strong></div>{[...totals].map(([currency, sum]) => <div key={currency}><small>Итого {currency}</small><strong>{money(sum, currency)}</strong></div>)}</div>
      {parsed.problems.length > 0 && <div className="setup-notice">Пропущены: {parsed.problems.slice(0, 5).join("; ")}{parsed.problems.length > 5 ? "…" : ""}</div>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Строка</th><th>Контрагент</th><th>БИН</th><th>Договор</th><th>Сальдо</th></tr></thead><tbody>
        {parsed.rows.slice(0, 15).map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.name}</td><td>{row.bin ?? "—"}</td><td>{row.contract ?? "—"}</td><td>{money(row.amount, row.currency)}</td></tr>)}
      </tbody></table></div>
      {parsed.rows.length > 15 && <p className="form-help">Показаны первые 15 из {parsed.rows.length}.</p>}
      <input type="hidden" name="file_name" value={fileName}/>
      <input type="hidden" name="rows" value={JSON.stringify(parsed.rows.map(({ name, bin, contract, currency, amount, due_date }) => ({ name, bin, contract, currency, amount, due_date })))}/>
      {parsed.rows.length > 0 && <PendingSubmitButton className="primary" pendingText="Загрузка…">Загрузить сальдо</PendingSubmitButton>}
    </>}
  </form>;
}
