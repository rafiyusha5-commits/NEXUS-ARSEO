// Regrade by expiry on the batch page (202611280800): part of the batch found to carry another expiry moves to the batch
// with the right one. Rendering only, shared by the page and its browser test; every rule is checked by the database.
import Link from "next/link";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import type { BatchRegrades, RegradeBalance } from "@/lib/inventory/expiry-regrade";

type Action = (data: FormData) => void | Promise<void>;
const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
const day = (value: string | null) => value ? value.slice(0, 10).split("-").reverse().join(".") : "—";
const amount = (value: number | string) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(Number(value));

export function ExpiryRegradePanel({ batchId, expiry, balances, data, regradeAction, cancelAction }: {
  batchId: string; expiry: string; balances: RegradeBalance[]; data: BatchRegrades; regradeAction: Action; cancelAction: Action;
}) {
  const free = balances.filter(balance => balance.on_hand - balance.reserved > 0);
  if (!data.can_regrade && !data.regrades.length) return null;
  return <section className="panel admin-section" id="expiry-regrade">
    <div className="panel-heading"><div><p className="eyebrow">Срок годности</p><h2>Пересорт по сроку</h2></div>
      {data.regrades.length > 0 && <span className="page-count">{data.regrades.length}</span>}</div>
    {data.can_regrade && <>
      <p className="form-help">Часть партии на самом деле с другим сроком (поставщик перепутал)? Перенесите её в партию с правильным сроком — того же товара
        и номера. Это не списание и не потеря: две корректировки с номером и причиной, отмена — здесь же. Переносится только свободное; зарезервированное
        сначала замените в заказе. Новая партия получает себестоимость, происхождение и состояние этой: заблокированная часть остаётся заблокированной.</p>
      {free.length > 0 ? <form action={regradeAction} className="reference-form">
        <input type="hidden" name="batch_id" value={batchId}/>
        <label className="wide-field">Где лежит часть с другим сроком<select name="balance_id" required defaultValue={free.length === 1 ? free[0].id : ""}>
          <option value="" disabled>Склад и место</option>
          {free.map(balance => <option key={balance.id} value={balance.id}>{balance.warehouse} · {balance.location ?? "без зоны"} · свободно {amount(balance.on_hand - balance.reserved)} {units[balance.uom] ?? balance.uom}</option>)}
        </select></label>
        <label>Сколько<input name="quantity" inputMode="decimal" required/></label>
        <label>Правильный срок годности<input name="expiry_date" type="date" required/></label>
        <label className="wide-field">Причина<input name="reason" required maxLength={500} placeholder={`Например: на 3 коробках срок не до ${day(expiry)}`}/></label>
        <PendingSubmitButton pendingText="Переносим…" className="primary" type="submit">Перенести в партию с правильным сроком</PendingSubmitButton>
      </form> : <p className="empty-state">Свободного остатка нет: всё зарезервировано или израсходовано.</p>}
    </>}
    {data.regrades.length > 0 && <div className="import-table-wrap"><table className="import-table expected-batches">
      <thead><tr><th>Номер</th><th>Когда</th><th>Срок</th><th>Количество</th><th>Место</th><th>Причина</th><th>Состояние</th><th></th></tr></thead>
      <tbody>{data.regrades.map(item => <tr key={item.id} className={item.status === "cancelled" ? "expected-batch-cancelled" : ""}>
        <td><strong>{item.number}</strong><small>{item.created_by ?? "—"}</small></td>
        <td>{day(item.created_at)}</td>
        <td>{item.direction === "out"
          ? <>до {day(item.from_expiry)} → <Link href={`/inventory/${item.to_batch_id}`}>до {day(item.to_expiry)}</Link>{item.new_batch ? <small>новая партия</small> : null}</>
          : <><Link href={`/inventory/${item.from_batch_id}`}>до {day(item.from_expiry)}</Link> → до {day(item.to_expiry)}</>}</td>
        <td>{amount(item.quantity)} {units[item.uom] ?? item.uom}</td>
        <td>{item.warehouse}<small>{item.location ?? "без зоны"}</small></td>
        <td>{item.reason}</td>
        <td>{item.status === "posted" ? "проведён" : "отменён"}{item.cancel_reason ? <small>{item.cancel_reason}</small> : null}</td>
        <td>{data.can_regrade && item.status === "posted" && <details><summary>Отменить</summary><form action={cancelAction} className="inline-action">
          <input type="hidden" name="batch_id" value={batchId}/><input type="hidden" name="regrade_id" value={item.id}/>
          <input name="reason" required maxLength={500} placeholder="Причина" aria-label="Причина отмены пересорта"/>
          <PendingSubmitButton pendingText="…" className="ghost" type="submit">Отменить пересорт</PendingSubmitButton></form></details>}</td>
      </tr>)}</tbody></table></div>}
  </section>;
}
