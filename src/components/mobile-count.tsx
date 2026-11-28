// Counting from a phone (202611280300, 202611280600): scan the place label, scan the product or batch, enter how much
// lies there. A blind count shows no book quantity; the records add up and a mistake is fixed by a new record in the
// full version. Rendering only; every rule is checked by record_inventory_count.
import Link from "next/link";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { ScanFeedback } from "@/components/scan-feedback";
import { ScanField } from "@/components/scan-field";
import { countQuantity, countStatusLabel, countedTotals, uomLabel, type CatalogProduct, type CountSheet } from "@/lib/inventory/counts";

type Action = (data: FormData) => void | Promise<void>;
export type CountPlace = { id: string | null; code: string };
export type CountProduct = CatalogProduct & { batch_id?: string | null; uom?: string | null };

export function MobileCountView({ sheet, place, products, code, warning, message, recordAction }: {
  sheet: CountSheet; place: CountPlace | null; products: CountProduct[] | null; code?: string; warning?: string | null;
  message?: { type: "error" | "success"; text: string } | null; recordAction: Action;
}) {
  const counting = sheet.status === "counting" || sheet.status === "recount";
  const round = sheet.round ?? 1;
  const placeKey = place ? place.id ?? "none" : "";
  const base = `/m/count/${sheet.id}`;
  const totals = place ? countedTotals(sheet.entries, round).filter(total => (total.entry.location_id ?? null) === place.id) : [];
  return <>
    <h1 className="mobile-title">Подсчёт {sheet.number}</h1>
    <p className="mobile-hint">{sheet.warehouse} · {sheet.blind ? "слепой: учётного количества здесь нет" : "открытый"}{round === 2 ? " · повторный подсчёт" : ""}</p>
    {message && <div className={`${message.type === "error" ? "login-error" : "login-success"} admin-message`}>{message.text}</div>}
    {!counting && <section className="mobile-card mobile-card-warning"><strong>Подсчёт не идёт</strong>
      <small>Статус: {countStatusLabel[sheet.status]}. Пересчёт ведут в <Link href={`/inventory/counts/${sheet.id}`}>полной версии</Link>.</small></section>}
    {counting && !sheet.can_record && <section className="mobile-card mobile-card-warning"><strong>Нет права вносить подсчёт</strong>
      <small>Нужно право «Инвентаризация: подсчёт».</small></section>}
    {counting && sheet.can_record && round === 2 && <section className="mobile-card"><strong>Повторно пересчитать</strong>
      <small>Только позиции из списка и не тем, кто считал их в первый раз.</small>
      {(sheet.recount ?? []).filter(item => !item.done).map(item => <form key={`${item.location_id}-${item.product_id}-${item.batch_id}-${item.uom}`} action={recordAction} className="mobile-form mobile-recount">
        <input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="round" value="2"/><input type="hidden" name="location_id" value={item.location_id ?? ""}/>
        <input type="hidden" name="product_id" value={item.product_id}/><input type="hidden" name="batch_id" value={item.batch_id ?? ""}/><input type="hidden" name="uom" value={item.uom}/>
        <strong>{item.location ?? "без зоны"} · {item.sku}</strong><small>{item.product} · партия {item.batch ?? "не определена"} · {uomLabel[item.uom] ?? item.uom}</small>
        <label>Количество<input name="quantity" inputMode="decimal" required/></label>
        <PendingSubmitButton pendingText="Записываем…" className="primary scan-button" type="submit">Записать</PendingSubmitButton>
      </form>)}
      {!(sheet.recount ?? []).some(item => !item.done) && <p className="mobile-hint">Список пересчитан.</p>}
    </section>}
    {counting && sheet.can_record && round === 1 && !place && <>
      <ScanField target={base} label="Отсканируйте этикетку места" placeholder="Этикетка места"/>
      {warning && <section className="mobile-card mobile-card-warning"><ScanFeedback ok={false} signature={`${code}:${warning}`}/><strong>{warning}</strong></section>}
      <form className="mobile-form" action={base}><label>или выберите место<select name="location" required defaultValue="">
        <option value="" disabled>Место пересчёта</option>
        {sheet.locations.map(location => <option key={location.id} value={location.id}>{location.code}</option>)}
        {sheet.no_location && <option value="none">Без зоны</option>}
      </select></label><button className="secondary scan-button" type="submit">Выбрать</button></form>
    </>}
    {counting && sheet.can_record && round === 1 && place && <>
      <section className="mobile-card"><small>Считаем место</small><strong className="mobile-big">{place.code}</strong><Link href={base}>Сменить место</Link></section>
      <ScanField target={`${base}?location=${placeKey}`} label="Отсканируйте товар или партию" placeholder="Штрихкод, GS1 или этикетка"/>
      {warning && <section className="mobile-card mobile-card-warning"><ScanFeedback ok={false} signature={`${code}:${warning}`}/><strong>{warning}</strong></section>}
      {products && products.length > 0 && <ScanFeedback ok signature={`${code}:${placeKey}`}/>}
      {products?.map(product => <form key={product.id} action={recordAction} className="mobile-card mobile-form">
        <input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="round" value="1"/>
        <input type="hidden" name="location_id" value={place.id ?? ""}/><input type="hidden" name="product_id" value={product.id}/>
        <strong className="mobile-big">{product.sku} · {product.product}</strong>
        <label>Партия<select name="batch_id" defaultValue={product.batch_id ?? product.batches[0]?.id ?? ""}>{product.batches.map(batch =>
          <option key={batch.id} value={batch.id}>{batch.batch}{batch.expiry_date ? ` · до ${batch.expiry_date}` : ""}</option>)}<option value="">Партия не определена</option></select></label>
        <label>Единица<select name="uom" defaultValue={product.uom && product.uoms.includes(product.uom) ? product.uom : product.uoms[0]}>{product.uoms.map(uom =>
          <option key={uom} value={uom}>{uomLabel[uom] ?? uom}</option>)}</select></label>
        <label>Количество<input name="quantity" inputMode="decimal" required autoFocus/></label>
        <label>Примечание<input name="note" maxLength={500} placeholder="Необязательно"/></label>
        <PendingSubmitButton pendingText="Записываем…" className="primary scan-button" type="submit">Записать</PendingSubmitButton>
      </form>)}
      {products && !products.length && <section className="mobile-card mobile-card-warning"><ScanFeedback ok={false} signature={`${code}:none`}/>
        <strong>Товар не найден в составе пересчёта</strong><small>Проверьте код или найдите товар по артикулу в полной версии.</small></section>}
      <section className="mobile-card"><strong>Посчитано на месте</strong>
        {totals.length ? <ul className="mobile-stock">{totals.map(total => <li key={total.entry.id}>
          <div><strong>{total.entry.sku}</strong><small>{total.entry.product} · партия {total.entry.batch ?? "не определена"}</small></div>
          <div className="mobile-qty"><strong>{countQuantity(total.quantity)}</strong><small>{uomLabel[total.entry.uom] ?? total.entry.uom} · записей {total.records}</small></div>
        </li>)}</ul> : <p className="mobile-hint">Пока ничего. Место без записей при завершении подсчёта считается пустым.</p>}
      </section>
    </>}
    <p><Link href="/m/count">← Инвентаризации</Link></p>
  </>;
}
