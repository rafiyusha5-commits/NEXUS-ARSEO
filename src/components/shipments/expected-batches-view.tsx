// Batches of the packing list and their labels on the page of a shipment (202611280700). Rendering only, shared by the
// page and its browser test; every rule is checked by the database.
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { quantity, shortDate } from "@/lib/scan/lookup";
import { expectedStateLabel, unitLabel, type PackingLot, type ShipmentExpected } from "@/lib/shipments/expected-batches";

type Action = (data: FormData) => void | Promise<void>;

export function ExpectedBatchesView({ shipment, lots, message, addAction, cancelAction }: {
  shipment: ShipmentExpected; lots: PackingLot[]; message?: { type: "error" | "success"; text: string } | null; addAction: Action; cancelAction: Action;
}) {
  const open = shipment.items.filter(item => !item.received);
  const printable = shipment.items.flatMap(item => item.batches).filter(batch => !["cancelled", "removed"].includes(batch.state));
  return <>
    {message && <div className={`${message.type === "error" ? "login-error" : "login-success"} admin-message`}>{message.text}</div>}
    <p className="form-help">Внесите партии из упаковочного листа поставщика и напечатайте наклейки заранее — их клеят на паллеты или коробки при приёмке.
      При приёмке наклейка привязывается к принятой партии, только если у той же позиции совпал номер партии, а срок — со сроком из листа, когда он указан.
      Не совпало — наклейка остаётся непривязанной и при сканировании говорит почему; наклейку принятой партии тогда печатают заново.</p>
    {!shipment.can_manage && <p className="empty-state">Вносить партии может сотрудник с правом на приёмку товара или на изменение поставок{shipment.status === "closed" || shipment.status === "cancelled" ? "; поставка закрыта или отменена" : ""}.</p>}

    {lots.length > 0 && <section className="panel admin-section" id="packing-list">
      <div className="panel-heading"><div><p className="eyebrow">Распознанные документы поставки</p><h2>Партии из упаковочного листа</h2></div>
        <span className="page-count">{lots.length}</span></div>
      <p className="form-help">В документе партия не связана с товаром: выберите позицию поставки. Срок, если его нет в листе, можно указать или оставить пустым — тогда при приёмке сверяется только номер.</p>
      {lots.map(lot => <form action={addAction} className="reference-form" key={lot.lot}>
        <input type="hidden" name="shipment_id" value={shipment.shipment_id}/><input type="hidden" name="source" value="packing_list"/>
        <input type="hidden" name="batch_number" value={lot.lot}/><input type="hidden" name="source_note" value={lot.documents.join(", ").slice(0, 300)}/>
        <strong className="wide-field">Партия {lot.lot}{lot.description ? ` · ${lot.description}` : ""}</strong>
        <label>Позиция поставки<select name="item_id" required defaultValue={open.length === 1 ? open[0].item_id : ""}>
          <option value="" disabled>Выберите товар</option>
          {open.map(item => <option key={item.item_id} value={item.item_id}>{item.transport_no ? `Машина №${item.transport_no} · ` : ""}{item.sku} · {item.product}</option>)}
        </select></label>
        <label>Годен до<input name="expiry_date" type="date" defaultValue={lot.expiry ?? ""}/></label>
        <label>Количество<input name="quantity" inputMode="decimal" defaultValue={lot.quantity ?? ""}/></label>
        <label>Наклеек<input name="packages" type="number" min={1} max={100} defaultValue={lot.packages != null ? Math.min(lot.packages, 100) : ""}/></label>
        <PendingSubmitButton pendingText="Добавляем…" className="secondary" type="submit">Добавить</PendingSubmitButton>
      </form>)}
    </section>}

    {shipment.items.map(item => <section className="panel admin-section" key={item.item_id} id={`item-${item.item_id}`}>
      <div className="panel-heading"><div><p className="eyebrow">{item.transport_no ? `Машина №${item.transport_no}` : "Не распределена по машинам"}{item.received ? " · принята" : ""}</p>
        <h2>{item.sku} · {item.product}</h2></div>
        <span className="page-count">{quantity(item.quantity)} {unitLabel[item.uom] ?? item.uom}</span></div>
      {item.batches.length > 0 ? <div className="import-table-wrap"><table className="import-table expected-batches">
        <thead><tr><th>Печать</th><th>Партия</th><th>Годен до</th><th>Произведён</th><th>Количество</th><th>Наклеек</th><th>Состояние</th><th>Наклейка</th><th></th></tr></thead>
        <tbody>{item.batches.map(batch => {
          const canPrint = !["cancelled", "removed"].includes(batch.state);
          return <tr key={batch.id} className={batch.state === "cancelled" ? "expected-batch-cancelled" : ["mismatch", "not_received", "missing"].includes(batch.state) ? "has-error" : ""}>
            <td>{canPrint && <input type="checkbox" name="ids" value={batch.id} form="print-labels" aria-label={`Печатать наклейку партии ${batch.batch}`} defaultChecked={!batch.printed && batch.state === "expected"}/>}</td>
            <td><strong>{batch.batch}</strong><small>{batch.source === "packing_list" ? `из листа${batch.source_note ? `: ${batch.source_note}` : ""}` : "вручную"}</small></td>
            <td>{shortDate(batch.expiry_date)}</td><td>{shortDate(batch.manufacture_date)}</td>
            <td>{batch.quantity ? quantity(batch.quantity) : "—"}</td>
            <td>{canPrint ? <input name={`copies_${batch.id}`} form="print-labels" type="number" min={1} max={100} defaultValue={batch.packages ?? 1} aria-label={`Наклеек партии ${batch.batch}`}/> : "—"}</td>
            <td>{expectedStateLabel[batch.state]}{batch.note ? <small>{batch.note}</small> : null}</td>
            <td>{batch.label_code ?? "—"}{batch.label_code && <small>{batch.printed ? "напечатана" : "не печаталась"}</small>}</td>
            <td>{shipment.can_manage && batch.state === "expected" && <details><summary>Отменить</summary><form action={cancelAction} className="inline-action">
              <input type="hidden" name="shipment_id" value={shipment.shipment_id}/><input type="hidden" name="expected_batch_id" value={batch.id}/>
              <input name="reason" required maxLength={300} placeholder="Причина" aria-label="Причина отмены"/>
              <PendingSubmitButton pendingText="…" className="ghost" type="submit">Отменить партию</PendingSubmitButton></form></details>}</td>
          </tr>;
        })}</tbody></table></div> : <p className="empty-state">Партий по листу нет.</p>}
      {shipment.can_manage && !item.received && <form action={addAction} className="reference-form">
        <input type="hidden" name="shipment_id" value={shipment.shipment_id}/><input type="hidden" name="item_id" value={item.item_id}/><input type="hidden" name="source" value="manual"/>
        <label>Номер партии<input name="batch_number" required maxLength={60} autoCapitalize="characters"/></label>
        <label>Годен до<input name="expiry_date" type="date"/></label>
        <label>Произведён<input name="manufacture_date" type="date"/></label>
        <label>Количество, {unitLabel[item.uom] ?? item.uom}<input name="quantity" inputMode="decimal"/></label>
        <label>Наклеек<input name="packages" type="number" min={1} max={100}/></label>
        <PendingSubmitButton pendingText="Добавляем…" className="secondary" type="submit">Добавить партию</PendingSubmitButton>
      </form>}
      {item.received && <p className="form-help">Машина принята: партии вносятся при приёмке, наклейки принятых партий — в разделе «Этикетки».</p>}
    </section>)}

    {shipment.orphans.length > 0 && <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Недействительные наклейки</p>
      <h2>Позиции удалены из поставки</h2></div></div>
      <p className="form-help">{shipment.orphans.map(orphan => `${orphan.sku} ${orphan.batch}${orphan.label_code ? ` (${orphan.label_code})` : ""}`).join(", ")}</p></section>}

    {printable.length > 0 && <form id="print-labels" className="panel admin-section inline-action" method="post" action="/m/labels/print" target="_blank">
      <input type="hidden" name="target_type" value="expected_batch"/><input type="hidden" name="return_to" value={`/shipments/${shipment.shipment_id}/batches`}/>
      <label>Формат<select name="format" defaultValue="thermal"><option value="thermal">Термопринтер: 58×40 мм</option><option value="a4">Лист A4: 24 наклейки 70×37 мм</option></select></label>
      <button className="primary" type="submit">Печать отмеченных (PDF)</button>
      <small>Наклеек каждой партии — столько, сколько указано в строке (паллет или коробок). Каждая печать записывается; код наклейки не меняется.</small>
    </form>}
  </>;
}
