"use client";
import { useActionState, useState } from "react";
import { allocationCents, type ExactAllocationContext } from "@/lib/finance/exact-allocation";
import { saveAllocation } from "./actions";

export function ExactAllocationForm({ context: c, requestId, canSave }: { context: ExactAllocationContext; requestId: string; canSave: boolean }) {
  const [result, action, pending] = useActionState(saveAllocation, {});
  const [amounts, setAmounts] = useState(c.lines.map(line => {
    const old = c.previous.find(p => p.shipment_item_id === line.item_id && p.currency_id === c.target_currency_id);
    return old ? Number(old.allocated_amount).toFixed(2) : "";
  }));
  let sum: bigint | null = null;
  try { sum = amounts.reduce((s, a) => s + allocationCents(a), BigInt(0)); } catch { /* Incomplete input. */ }
  const exact = sum !== null && sum === allocationCents(c.total);
  const displaySum = sum === null ? "заполните все строки" : `${sum / BigInt(100)},${String(sum % BigInt(100)).padStart(2, "0")} ${c.target_currency}`;
  return <form action={action} className="doc-subform">
    <input type="hidden" name="request_id" value={requestId}/><input type="hidden" name="expense_id" value={c.expense_id}/>
    <input type="hidden" name="currency_id" value={c.target_currency_id}/><input type="hidden" name="source_document_id" value={c.source_document_id ?? ""}/><input type="hidden" name="stamp" value={c.stamp}/>
    {c.lines.map((line, i) => <label key={line.item_id}>{line.sku} · {line.name} · {line.quantity} {line.uom}
      <input type="hidden" name="item_id" value={line.item_id}/>
      <input aria-label={`Сумма ${line.sku}`} name="amount" inputMode="decimal" required maxLength={15} value={amounts[i]} onChange={e => setAmounts(previous => previous.map((a, j) => i === j ? e.target.value : a))}/>
    </label>)}
    <p aria-live="polite">Сумма строк: {displaySum}. Требуется: {c.total} {c.target_currency}.{exact ? " Суммы совпадают." : " Суммы должны совпасть точно."}</p>
    <label>Источник и основание распределения<textarea name="basis_note" minLength={10} maxLength={2000} required placeholder="Как определены суммы, источник данных и причина перераспределения, если оно повторное"/></label>
    {result.error && <p role="alert" className="login-error">{result.error}</p>}
    {result.success && <p role="status" className="login-success">{result.success} <a href={`/finance?shipment=${c.shipment_id}`}>К расходам и расчёту</a></p>}
    <button className="primary" disabled={!canSave || !exact || pending || !!result.success}>{pending ? "Сохраняется…" : c.status === "draft" ? "Подтвердить расход и сохранить распределение" : "Сохранить распределение"}</button>
  </form>;
}
