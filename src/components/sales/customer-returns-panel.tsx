import { linkedDocuments, LinkedDocuments } from "@/components/documents/linked-documents";
import { cancelCustomerReturnAction, createCustomerReturnAction, decideReturnItemAction } from "@/app/sales/returns-actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { loadPermissions } from "@/lib/permissions";
import { RETURN_DECISIONS, RETURN_REASONS, RETURN_STATUS } from "@/lib/sales/returns";
import { createClient } from "@/lib/supabase/server";

const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
const number = (value: unknown) => Number(value ?? 0).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;

type ReturnOption = { sale_item_id: string; batch_id: string; batch_number: string; expiry_date: string; internal_sku: string; product_name: string; uom: string; shipped: number; returned: number; available: number };
type ReturnItem = { id: string; quantity: number; uom: string; reason_code: string; decision: string | null; decision_note: string | null; decided_at: string | null; batch: unknown; sale_item: unknown };
type ReturnRow = { id: string; return_number: string; status: string; reason: string | null; received_at: string; cancellation_reason: string | null; items: ReturnItem[] };

// Returns of one customer order: the return form for a shipped order, and the decisions on goods in quarantine.
export async function CustomerReturnsPanel({ saleId, saleStatus, warehouseId }: { saleId: string; saleStatus: string; warehouseId: string }) {
  const supabase = await createClient();
  const permissions = await loadPermissions(supabase, ["sales.returns", "inventory.receive", "inventory.write_off"] as const);
  const [{ data: optionRows }, { data: returnRows, error }, { data: locations }] = await Promise.all([
    saleStatus === "shipped" ? supabase.rpc("customer_return_options", { p_sale_id: saleId }) : Promise.resolve({ data: [] }),
    supabase.from("customer_returns").select("id,return_number,status,reason,received_at,cancellation_reason,items:customer_return_items(id,quantity,uom,reason_code,decision,decision_note,decided_at,batch:inventory_batches(batch_number),sale_item:sale_items(product:products(internal_sku,name)))").eq("sale_id", saleId).order("received_at", { ascending: false }),
    supabase.from("warehouse_locations").select("id,code,zone").eq("warehouse_id", warehouseId).eq("status", "active").order("code"),
  ]);
  if (error) return <section className="panel admin-section"><div className="setup-notice">Возвраты недоступны. Если модуль ещё не подключён, примените миграцию <strong>202609277500_customer_returns.sql</strong>.</div></section>;
  const options = ((optionRows ?? []) as ReturnOption[]).filter(option => Number(option.available) > 0);
  const returns = (returnRows ?? []) as ReturnRow[];
  const documents = await linkedDocuments(supabase, "customer_return", returns.map(row => row.id));
  const canDecide = permissions["inventory.receive"] || permissions["inventory.write_off"];
  return <>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Возврат от покупателя</p><h2>Оформить возврат</h2></div></div>
      {saleStatus !== "shipped" && <p className="form-help">Возврат оформляется по отгруженному заказу.</p>}
      {saleStatus === "shipped" && !permissions["sales.returns"] && <p className="form-help">Нужно право «Клиентские заказы: возвраты».</p>}
      {saleStatus === "shipped" && permissions["sales.returns"] && (options.length ? <form action={createCustomerReturnAction} className="customer-return-form">
        <input type="hidden" name="sale_id" value={saleId}/>
        <p className="form-help">Укажите, сколько вернул покупатель по каждой партии. Вернуть больше отгруженного нельзя. Товар примется в карантин и не попадёт в свободный остаток, пока по нему не принято решение.</p>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Товар · партия</th><th>Отгружено</th><th>Уже возвращено</th><th>Возвращает</th><th>Причина</th></tr></thead><tbody>
          {options.map(option => { const key = `${option.sale_item_id}_${option.batch_id}`; const unit = units[option.uom] ?? option.uom; return <tr key={key}>
            <td><strong>{option.internal_sku}</strong> {option.product_name}<small>Партия {option.batch_number}</small></td>
            <td>{number(option.shipped)} {unit}</td><td>{number(option.returned)}</td>
            <td><input name={`qty_${key}`} inputMode="decimal" placeholder={`до ${number(option.available)}`} aria-label={`Возвращает: партия ${option.batch_number}`}/></td>
            <td><select name={`reason_${key}`} defaultValue="defect" aria-label={`Причина: партия ${option.batch_number}`}>{Object.entries(RETURN_REASONS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></td>
          </tr>; })}
        </tbody></table></div>
        <div className="source-review-actions"><label>Комментарий<input name="reason" maxLength={500} placeholder="Например: акт о расхождении № 15"/></label><PendingSubmitButton className="primary compact" pendingText="Оформляем…">Оформить возврат</PendingSubmitButton></div>
      </form> : <p className="form-help">Все отгруженные партии уже возвращены или возвращать нечего.</p>)}
    </section>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Карантин и решения</p><h2>Возвраты по заказу</h2></div><span className="page-count">{returns.length}</span></div>
      {!returns.length && <p className="empty-state">Возвратов по заказу не было.</p>}
      <div className="customer-return-list">{returns.map(entry => <article key={entry.id} className={`customer-return return-${entry.status}`}>
        <LinkedDocuments entries={documents.get(entry.id)}/><div className="customer-return-head"><strong>{entry.return_number}</strong><span className="reference-tag">{RETURN_STATUS[entry.status] ?? entry.status}</span><time>{dateTime(entry.received_at)}</time></div>
        {entry.reason && <small>{entry.reason}</small>}
        {entry.status === "cancelled" && <small>Отменён: {entry.cancellation_reason}</small>}
        <ul>{entry.items.map(item => { const product = one(one(item.sale_item as { product: unknown } | null)?.product as { internal_sku?: string; name?: { ru?: string } } | null); const batch = one(item.batch as { batch_number?: string } | null); return <li key={item.id}>
          <div><strong>{product?.internal_sku} {product?.name?.ru}</strong> · партия {batch?.batch_number} · {number(item.quantity)} {units[item.uom] ?? item.uom} · {RETURN_REASONS[item.reason_code] ?? item.reason_code}</div>
          {item.decision ? <small>{RETURN_DECISIONS[item.decision] ?? item.decision}{item.decision_note ? `: ${item.decision_note}` : ""}{item.decided_at ? ` · ${dateTime(item.decided_at)}` : ""}</small>
            : entry.status !== "cancelled" && (canDecide ? <form action={decideReturnItemAction} className="customer-return-decision">
              <input type="hidden" name="sale_id" value={saleId}/><input type="hidden" name="item_id" value={item.id}/>
              <select name="decision" defaultValue="" required aria-label="Решение по позиции"><option value="" disabled>Решение…</option>{permissions["inventory.receive"] && <option value="restock">{RETURN_DECISIONS.restock}</option>}{permissions["inventory.write_off"] && <><option value="write_off">{RETURN_DECISIONS.write_off}</option><option value="return_to_supplier">{RETURN_DECISIONS.return_to_supplier}</option></>}</select>
              <select name="location_id" defaultValue="" aria-label="Зона склада для возврата в продажу"><option value="">Без зоны</option>{(locations ?? []).map(location => <option key={location.id} value={location.id}>{location.code}</option>)}</select>
              <input name="note" maxLength={500} placeholder="Комментарий (обязателен для списания и возврата поставщику)" aria-label="Комментарий к решению"/>
              <PendingSubmitButton className="secondary compact" pendingText="Сохраняем…">Принять решение</PendingSubmitButton>
            </form> : <small>Ждёт решения склада</small>)}
        </li>; })}</ul>
        {entry.status === "quarantine" && permissions["sales.returns"] && entry.items.every(item => !item.decision) && <form action={cancelCustomerReturnAction} className="inline-action">
          <input type="hidden" name="sale_id" value={saleId}/><input type="hidden" name="return_id" value={entry.id}/>
          <input name="reason" required maxLength={500} placeholder="Причина отмены" aria-label={`Причина отмены ${entry.return_number}`}/><button className="ghost compact" type="submit">Отменить возврат</button>
        </form>}
      </article>)}</div>
    </section>
  </>;
}
