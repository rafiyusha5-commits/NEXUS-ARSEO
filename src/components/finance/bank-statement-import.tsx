"use client";

import { useState } from "react";
import { ImportReview } from "@/components/finance/import-review";
import { decodeStatement, parseBankStatement, type ParsedStatement } from "@/lib/finance/bank-statement";
import { money } from "@/lib/finance/receivables";

async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const day = (value: string | null) => value ? value.split("-").reverse().join(".") : "—";

// The statement is read in the browser; only incoming payments go to the server, the file itself is not stored.
export function BankStatementImport({ currencies }: { currencies: string[] }) {
  const [parsed, setParsed] = useState<ParsedStatement | null>(null);
  const [file, setFile] = useState<{ name: string; sha: string } | null>(null);
  const [currency, setCurrency] = useState("");
  const [problem, setProblem] = useState("");
  async function load(selected?: File) {
    setParsed(null); setFile(null); setProblem(""); setCurrency("");
    if (!selected) return;
    try {
      const buffer = await selected.arrayBuffer();
      const result = parseBankStatement(decodeStatement(new Uint8Array(buffer)));
      setFile({ name: selected.name, sha: await sha256(buffer) });
      setParsed(result);
      if (result.currency && currencies.includes(result.currency)) setCurrency(result.currency);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Не удалось прочитать файл.");
    }
  }
  const total = (parsed?.incoming ?? []).reduce((sum, payment) => sum + payment.amount, 0);
  return <div className="bank-import">
    <label className="wide-field">Файл выписки для 1С (kl_to_1c.txt)<input type="file" accept=".txt,text/plain" onChange={event => load(event.target.files?.[0])}/></label>
    <p className="form-help">В интернет-банке выберите выгрузку выписки «для 1С». Файл читается на этом компьютере, в Nexus попадают только поступления: дата, сумма, плательщик, БИН и назначение. Повторно загруженные платежи пропускаются.</p>
    {problem && <div className="login-error admin-message">{problem}</div>}
    {parsed && file && <>
      <div className="operation-facts">
        <div><small>Счёт</small><strong>{parsed.accounts.join(", ") || "не указан"}</strong></div>
        <div><small>Период</small><strong>{day(parsed.periodFrom)} — {day(parsed.periodTo)}</strong></div>
        <div><small>Поступлений</small><strong>{parsed.incoming.length} на {money(total, currency)}</strong></div>
        <div><small>Списаний (пропущены)</small><strong>{parsed.outgoing}</strong></div>
      </div>
      {parsed.problems.length > 0 && <div className="setup-notice">Не прочитаны: {parsed.problems.slice(0, 5).join("; ")}{parsed.problems.length > 5 ? "…" : ""}</div>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Дата</th><th>№</th><th>Плательщик</th><th>Сумма</th><th>Назначение</th></tr></thead><tbody>
        {parsed.incoming.map((payment, index) => <tr key={index}><td>{day(payment.doc_date)}</td><td>{payment.doc_number ?? "—"}</td><td>{payment.payer_name ?? "—"}<small>{payment.payer_bin ? `БИН ${payment.payer_bin}` : ""}</small></td><td>{money(payment.amount)}</td><td>{payment.purpose ?? "—"}</td></tr>)}
      </tbody></table></div>
      <input type="hidden" name="file_name" value={file.name}/><input type="hidden" name="file_sha256" value={file.sha}/>
      <input type="hidden" name="account" value={parsed.accounts[0] ?? ""}/><input type="hidden" name="period_from" value={parsed.periodFrom ?? ""}/><input type="hidden" name="period_to" value={parsed.periodTo ?? ""}/>
      <input type="hidden" name="payments" value={JSON.stringify(parsed.incoming)}/>
      <div className="inline-form"><label>Валюта счёта<select name="currency" value={currency} onChange={event => setCurrency(event.target.value)}><option value="">Укажите валюту по выписке</option>{currencies.map(code => <option key={code} value={code}>{code}</option>)}</select></label></div>
      {currency && parsed.accounts.length === 1 && parsed.incoming.length > 0 && <ImportReview key={`${file.sha}:${currency}`} payload={{ kind:"bank",file_name:file.name,file_sha256:file.sha,currency,account:parsed.accounts[0],period_from:parsed.periodFrom,period_to:parsed.periodTo,rows:parsed.incoming.map(row => ({...row})),problems:parsed.problems }}/ >}
      {parsed.accounts.length !== 1 && <p role="alert">Нужна выписка одного счёта и одной валюты. Многосчётный файл не загружается.</p>}
    </>}
  </div>;
}
