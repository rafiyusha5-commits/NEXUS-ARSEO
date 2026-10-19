"use client";

import { useState } from "react";
import { previewImport, confirmImport } from "@/app/finance/receivables/import-actions";
import type { ImportPayload, ImportReview as Review } from "@/lib/finance/import-review";
import { money } from "@/lib/finance/receivables";

const labels = { new: "Новая строка", duplicate: "Ранее загружена", error: "Требуется проверка" };
const reasons: Record<string,string> = { auto_bin: "точный БИН", auto_order: "номер заказа", exact_name: "точное название", duplicate: "идентификатор операции", unmatched: "не сопоставлен — останется неразнесённым" };

// Mounted with a new key whenever file/date/currency changes: a stale plan cannot confirm a different selection.
export function ImportReview({ payload }: { payload: ImportPayload }) {
  const [edits, setEdits] = useState<Record<number, Record<string, unknown>>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [dirty, setDirty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const current = { ...payload, rows: payload.rows.map((row, i) => ({ ...row, ...edits[i] })) };
  function edit(index: number, value: Record<string,unknown>) {
    setEdits(previous => ({ ...previous, [index]: { ...previous[index], ...value } })); setDirty(true); setMessage("");
  }
  async function preview() {
    setBusy(true); setMessage("");
    try {
      const result = await previewImport(current);
      if (result.error) { setMessage(result.error); setReview(null); }
      else { setReview(result.review!); setDirty(false); }
    } catch { setMessage("Не удалось получить предпросмотр. Финансовые данные не изменены."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!review || dirty) return;
    setBusy(true); setMessage("");
    try {
      const result = await confirmImport(requestId, current, review.fingerprint);
      setMessage(result.error || result.message || "");
      if (result.error) setDirty(true); else setDone(true);
    } catch { setMessage("Ответ не получен. Повторите подтверждение этого пакета: повторный учёт защищён базой."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Проверка перед импортом" className="bank-import import-review">
    <p className="form-help">Предпросмотр не записывает деньги. Ошибки блокируют весь пакет. Нераспознанный покупатель банковского платежа остаётся в списке неразнесённых.</p>
    {message && <p role="status" className="setup-notice">{message}</p>}
    <button type="button" className="secondary" disabled={busy || done || payload.problems.length > 0} onClick={preview}>Проверить с базой / обновить варианты</button>
    {review && <>
      <p className="form-help">Суммы ниже относятся ко всем строкам файла, включая повторы. Повторы не создают новых оплат.</p>
      <div className="operation-facts">{review.totals.map(t => <div key={t.currency}><small>{t.count} строк · {t.currency}</small><strong>{money(t.amount,t.currency)}</strong></div>)}</div>
      {review.existing_batch_id && <p className="setup-notice">Этот файл уже подтверждён. Повтор возвращает результат сохранённого пакета.</p>}
      <p>Новых: {review.rows.filter(r => r.status === "new").length}. Ранее загруженных: {review.rows.filter(r => r.status === "duplicate").length}. Требуют проверки: {review.rows.filter(r => r.status === "error").length}.</p>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Строка</th><th>Результат</th><th>Покупатель / основание</th><th>Сумма</th><th>Ручное решение</th></tr></thead><tbody>
        {review.rows.map((row,i) => <tr key={row.ordinal}>
          <td data-label="Строка">{String(payload.rows[i].rowNumber ?? row.ordinal)}</td><td data-label="Результат">{labels[row.status]}{row.problem && <small>{row.problem}</small>}</td>
          <td data-label="Покупатель / основание">{row.customer_name || "Не сопоставлен"}<small>{reasons[row.match_reason || ""] || "—"}</small></td><td data-label="Сумма">{money(row.amount,row.currency)}</td>
          <td data-label="Ручное решение"><fieldset disabled={busy || done}>
            {payload.kind === "bank" && !payload.rows[i].operation_id && <label>Устойчивый ID банка (не дата + сумма)<input aria-label={`ID операции ${row.ordinal}`} value={String(edits[i]?.operation_id ?? "")} onChange={e => edit(i,{ operation_id:e.target.value,identity_source:"manual" })}/></label>}
            {row.legacy_candidates.length > 0 && <label>Сравнение с прежними платежами<select value={String(edits[i]?.legacy_id || edits[i]?.legacy_decision || "")} onChange={e => edit(i,e.target.value === "different" ? { legacy_decision:"different",legacy_id:null } : { legacy_decision:"same",legacy_id:e.target.value })}>
              <option value="">Выберите решение</option><option value="different">Отдельная реальная операция</option>{row.legacy_candidates.map(c => <option key={c.id} value={c.id}>Тот же платёж №{c.number} от {c.date}, {c.amount}</option>)}
            </select></label>}
            {row.previous_balance && <label><input type="checkbox" checked={edits[i]?.replace_id === row.previous_balance.id} onChange={e => edit(i,{ replace_id:e.target.checked ? row.previous_balance!.id : null })}/> Заменить действующее сальдо {money(row.previous_balance.amount,row.currency)} на {row.previous_balance.as_of}; прежняя запись останется в истории</label>}
            {(!payload.rows[i].operation_id && payload.kind === "bank" || row.previous_balance || row.legacy_candidates.length>0) && <label>Причина и основание решения<input value={String(edits[i]?.reason ?? "")} onChange={e => edit(i,{ reason:e.target.value })}/></label>}
          </fieldset></td>
        </tr>)}
      </tbody></table></div>
      <p className="form-help">Показаны все {review.rows.length} строк. {dirty ? "Решения изменены — обновите предпросмотр." : "При подтверждении база повторно проверит права, совпадения и конфликты."}</p>
      <button type="button" className="primary" disabled={busy || done || dirty || !review.can_confirm} onClick={confirm}>{busy ? "Проверка…" : "Подтвердить загрузку"}</button>
    </>}
  </section>;
}
