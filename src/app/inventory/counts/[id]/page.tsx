import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requirePageUser } from "@/lib/auth/access";
import {
  countDate, countedTotals, countKindLabel, countMoney, countQuantity, countStatusLabel, lineKindLabel, problemLabel, uomLabel, zoneLabel,
  type CatalogProduct, type CountReview, type CountSheet, type ReviewLine,
} from "@/lib/inventory/counts";
import {
  cancelInventoryCount, finishInventoryCountRound, pairInventoryCountLines, postInventoryCount, recordInventoryCount,
  setInventoryCountDecision, setInventoryCountScope, startInventoryCount,
} from "../actions";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Search = { error?: string; success?: string; location?: string; q?: string };

// One count: its scope, the counting rounds, the review of differences and the posting. What the employee may see is
// decided by the database (no book quantity in a blind count until review, and then only for the approver).
export default async function InventoryCountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  if (!uuid.test(id)) notFound();
  const search = await searchParams;
  const { profile, roles, supabase } = await requirePageUser();
  const { data, error } = await supabase.rpc("inventory_count_sheet", { p_count_id: id });
  const sheet = data as CountSheet | null;
  const reviewable = sheet && (sheet.status === "review" || sheet.status === "posted" || (sheet.status === "cancelled" && sheet.review_at));
  const review = reviewable ? await supabase.rpc("inventory_count_review", { p_count_id: id }) : null;
  const query = (search.q ?? "").trim().slice(0, 60);
  const catalog = sheet && query && ["draft", "counting"].includes(sheet.status)
    ? ((await supabase.rpc("inventory_count_catalog", { p_count_id: id, p_query: query })).data ?? []) as CatalogProduct[] : [];
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="inventory-counts"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Инвентаризация</p><h1>{sheet?.number ?? "Пересчёт"}</h1></div>
      <div className="topbar-actions">
        {sheet && sheet.status !== "draft" && <a className="ghost button-link" href={`/inventory/counts/${id}/sheet`}>Бланк PDF</a>}
        {review && !review.error && <a className="ghost button-link" href={`/inventory/counts/${id}/export`}>Отчёт XLSX</a>}
        <Link className="ghost button-link" href="/inventory/counts">К журналу</Link></div></header>
    {search.error && <div className="login-error admin-message">{search.error}</div>}{search.success && <div className="login-success admin-message">{search.success}</div>}
    {error && <div className="setup-notice">Инвентаризация недоступна: нужно право на остатки или на пересчёт.</div>}
    {sheet && <>
      <section className="shipment-summary-grid">
        <article className="summary-card"><p>Статус</p><strong>{countStatusLabel[sheet.status]}</strong><small>{countKindLabel[sheet.kind]}{sheet.blind ? " · слепой" : " · открытый"}</small></article>
        <article className="summary-card"><p>Склад</p><strong>{sheet.warehouse}</strong><small>ответственный: {sheet.responsible ?? "—"}</small></article>
        <article className="summary-card"><p>Начат</p><strong>{countDate(sheet.started_at)}</strong><small>допуск {countQuantity(sheet.tolerance_pieces)} шт.</small></article>
      </section>
      {sheet.note && <p className="form-help">{sheet.note}</p>}
      {sheet.adjustment_document_id && <p className="form-help">Документ корректировки: <Link href={`/inventory/movements/${sheet.adjustment_document_id}`}>{sheet.adjustment_document}</Link></p>}
      {sheet.status === "cancelled" && <p className="form-help">Отменена {countDate(sheet.cancelled_at)}: {sheet.cancellation_reason}</p>}
      <Scope sheet={sheet}/>
      {sheet.status === "draft" && <Draft sheet={sheet} catalog={catalog} query={query}/>}
      {(sheet.status === "counting" || sheet.status === "recount") && <Counting sheet={sheet} catalog={catalog} query={query} search={search}/>}
      {review && (review.error
        ? <div className="setup-notice">{/утверждающий/.test(review.error.message) ? "Учётный остаток слепого пересчёта видит только утверждающий." : "Разбор недоступен."}</div>
        : <Review sheet={sheet} review={review.data as CountReview}/>)}
      <Cancel sheet={sheet}/>
    </>}
  </section></main>;
}

function Scope({ sheet }: { sheet: CountSheet }) {
  if (sheet.kind === "full") return <p className="form-help">Пересчитывается весь склад, включая остатки без зоны.</p>;
  if (!sheet.scope.length) return null;
  const locations = sheet.scope.filter(item => item.type === "location").map(item => item.location);
  const products = sheet.scope.filter(item => item.type === "product").map(item => `${item.sku} ${item.product}`);
  return <p className="form-help">Состав: {locations.length ? `места ${locations.join(", ")}` : "все места"}
    {sheet.scope.some(item => item.type === "no_location") ? ", остатки без зоны" : ""}
    {products.length ? `; товары: ${products.join("; ")}` : ""}.</p>;
}

function Draft({ sheet, catalog, query }: { sheet: CountSheet; catalog: CatalogProduct[]; query: string }) {
  if (!sheet.can_manage) return <p className="empty-state">Черновик готовит сотрудник с правом «Инвентаризация: ведение».</p>;
  const scoped = new Set(sheet.scope.map(item => item.location_id ?? item.product_id));
  const zones = [...new Set(sheet.locations.map(location => location.zone))];
  return <section className="panel admin-section">
    <div className="panel-heading"><div><p className="eyebrow">Черновик</p><h2>Состав и старт</h2></div></div>
    {sheet.kind === "partial" && <>
      <form className="inline-action" action={`/inventory/counts/${sheet.id}`}>
        <label>Найти товар для состава<input name="q" defaultValue={query} placeholder="Артикул, название или штрихкод"/></label>
        <button className="ghost" type="submit">Найти</button></form>
      <form action={setInventoryCountScope} className="reference-form">
        <input type="hidden" name="count_id" value={sheet.id}/>
        <fieldset className="wide-field"><legend>Места</legend>{sheet.locations.map(location =>
          <label className="check-label" key={location.id}><input type="checkbox" name="location_ids" value={location.id} defaultChecked={scoped.has(location.id)}/> {location.code} <small>{zoneLabel[location.zone] ?? location.zone}</small></label>)}
          <label className="check-label"><input type="checkbox" name="no_location" defaultChecked={sheet.scope.some(item => item.type === "no_location")}/> Остатки без зоны</label></fieldset>
        <fieldset className="wide-field"><legend>Зоны целиком</legend>{zones.map(zone =>
          <label className="check-label" key={zone}><input type="checkbox" name="zones" value={zone}/> {zoneLabel[zone] ?? zone}</label>)}</fieldset>
        <fieldset className="wide-field"><legend>Товары (пусто — все товары выбранных мест)</legend>
          {sheet.scope.filter(item => item.type === "product").map(item =>
            <label className="check-label" key={item.product_id}><input type="checkbox" name="products" value={item.product_id ?? ""} defaultChecked/> {item.sku} {item.product}</label>)}
          {catalog.filter(product => !scoped.has(product.id)).map(product =>
            <label className="check-label" key={product.id}><input type="checkbox" name="products" value={product.id}/> {product.sku} {product.product}</label>)}</fieldset>
        <PendingSubmitButton pendingText="Сохраняем…" className="secondary" type="submit">Сохранить состав</PendingSubmitButton>
      </form></>}
    <form action={startInventoryCount} className="inline-action"><input type="hidden" name="count_id" value={sheet.id}/>
      <PendingSubmitButton pendingText="Начинаем…" className="primary" type="submit">Начать пересчёт</PendingSubmitButton>
      <small>При старте запоминается учётный остаток, а движения по считаемым местам блокируются.</small></form>
  </section>;
}

function Counting({ sheet, catalog, query, search }: { sheet: CountSheet; catalog: CatalogProduct[]; query: string; search: Search }) {
  const round = sheet.round ?? 1;
  const location = search.location === "none" ? "none" : sheet.locations.find(item => item.id === search.location)?.id ?? "";
  const totals = countedTotals(sheet.entries, round);
  const own = sheet.entries.filter(entry => entry.round === round);
  return <section className="panel admin-section" id="count">
    <div className="panel-heading"><div><p className="eyebrow">{round === 1 ? "Первый подсчёт" : "Повторный подсчёт"}</p><h2>Подсчёт</h2></div>
      <span className="page-count">{totals.length} позиций</span></div>
    <p className="form-help">{sheet.blind ? "Слепой пересчёт: считайте то, что лежит на месте, учётного количества здесь нет. " : ""}Записи одной позиции складываются: двое могут считать одно место. Ошибку исправляют новой записью — прежняя остаётся в истории. Найденный товар без читаемой партии записывается как «партия не определена».{round === 2 ? " Повторно пересчитываются только позиции из списка, и не тем, кто считал их в первый раз." : ""}</p>
    {round === 2 && sheet.recount && <div className="import-table-wrap"><table className="import-table">
      <thead><tr><th>Место</th><th>Товар</th><th>Партия</th><th>Единица</th><th>Первый подсчёт</th><th>Записать повторно</th></tr></thead>
      <tbody>{sheet.recount.map(item => <tr key={`${item.location_id}-${item.product_id}-${item.batch_id}-${item.uom}`} className={item.done ? "" : "has-error"}>
        <td>{item.location ?? "без зоны"}</td><td>{item.sku} {item.product}</td><td>{item.batch ?? "не определена"}</td><td>{uomLabel[item.uom] ?? item.uom}</td>
        <td><small>{item.first_counters.join(", ")}</small></td>
        <td>{sheet.can_record && <form action={recordInventoryCount} className="inline-action">
          <input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="round" value="2"/><input type="hidden" name="location_id" value={item.location_id ?? ""}/>
          <input type="hidden" name="product_id" value={item.product_id}/><input type="hidden" name="batch_id" value={item.batch_id ?? ""}/><input type="hidden" name="uom" value={item.uom}/>
          <input name="quantity" inputMode="decimal" required placeholder="Количество" aria-label="Количество"/>
          <PendingSubmitButton pendingText="…" className="secondary" type="submit">{item.done ? "Добавить" : "Записать"}</PendingSubmitButton></form>}</td>
      </tr>)}</tbody></table></div>}
    {round === 1 && sheet.can_record && <>
      <form className="inline-action" action={`/inventory/counts/${sheet.id}`}>
        <label>Место<select name="location" defaultValue={location}><option value="" disabled>Выберите место</option>
          {sheet.locations.map(item => <option key={item.id} value={item.id}>{item.code}</option>)}{sheet.no_location && <option value="none">Без зоны</option>}</select></label>
        <label>Товар<input name="q" defaultValue={query} required placeholder="Артикул, название или штрихкод"/></label>
        <button className="ghost" type="submit">Найти</button></form>
      {location && catalog.map(product => <form action={recordInventoryCount} className="reference-form" key={product.id}>
        <input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="round" value="1"/>
        <input type="hidden" name="location_id" value={location === "none" ? "" : location}/><input type="hidden" name="product_id" value={product.id}/>
        <strong className="wide-field">{product.sku} · {product.product}</strong>
        <label>Партия<select name="batch_id" defaultValue={product.batches[0]?.id ?? ""}>{product.batches.map(batch =>
          <option key={batch.id} value={batch.id}>{batch.batch}{batch.expiry_date ? ` · до ${batch.expiry_date}` : ""}</option>)}<option value="">Партия не определена</option></select></label>
        <label>Единица<select name="uom">{product.uoms.map(uom => <option key={uom} value={uom}>{uomLabel[uom] ?? uom}</option>)}</select></label>
        <label>Количество<input name="quantity" inputMode="decimal" required/></label>
        <label>Примечание<input name="note" maxLength={500}/></label>
        <PendingSubmitButton pendingText="Записываем…" className="primary" type="submit">Записать</PendingSubmitButton>
      </form>)}
      {location && query && !catalog.length && <p className="empty-state">Товар не найден в составе пересчёта.</p>}
    </>}
    {totals.length > 0 && <div className="import-table-wrap"><table className="import-table">
      <caption>Посчитано в этом туре</caption>
      <thead><tr><th>Место</th><th>Товар</th><th>Партия</th><th>Единица</th><th>Количество</th><th>Записей</th></tr></thead>
      <tbody>{totals.map(total => <tr key={total.entry.id}><td>{total.entry.location ?? "без зоны"}</td><td>{total.entry.sku} {total.entry.product}</td>
        <td>{total.entry.batch ?? "не определена"}</td><td>{uomLabel[total.entry.uom] ?? total.entry.uom}</td><td><strong>{countQuantity(total.quantity)}</strong></td><td>{total.records}</td></tr>)}</tbody>
    </table></div>}
    {own.length > 0 && <details><summary>Все записи тура ({own.length})</summary><div className="operation-history-list">{own.map(entry =>
      <article className="operation-history-row" key={entry.id}><time>{countDate(entry.counted_at)}</time>
        <div><strong>{entry.location ?? "без зоны"} · {entry.sku} · {entry.batch ?? "партия не определена"} · {countQuantity(entry.quantity)} {uomLabel[entry.uom] ?? entry.uom}{entry.superseded ? " (исправлено)" : ""}</strong>
          <small>{entry.counted_by ?? "—"}{entry.note ? ` · ${entry.note}` : ""}{entry.supersedes_entry_id ? " · исправление" : ""}</small>
          {sheet.can_record && !entry.superseded && <form action={recordInventoryCount} className="inline-action">
            <input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="round" value={round}/><input type="hidden" name="location_id" value={entry.location_id ?? ""}/>
            <input type="hidden" name="product_id" value={entry.product_id}/><input type="hidden" name="batch_id" value={entry.batch_id ?? ""}/>
            <input type="hidden" name="uom" value={entry.uom}/><input type="hidden" name="supersedes_entry_id" value={entry.id}/>
            <input name="quantity" inputMode="decimal" required defaultValue={entry.quantity} aria-label="Верное количество"/>
            <input name="note" maxLength={500} placeholder="Почему исправлено" aria-label="Причина исправления"/>
            <PendingSubmitButton pendingText="…" className="ghost" type="submit">Исправить</PendingSubmitButton></form>}</div>
      </article>)}</div></details>}
    {sheet.book && <details><summary>Учётный остаток (открытый пересчёт)</summary><div className="import-table-wrap"><table className="import-table">
      <thead><tr><th>Место</th><th>Товар</th><th>Партия</th><th>Единица</th><th>Учёт</th></tr></thead>
      <tbody>{sheet.book.map(row => <tr key={`${row.location_id}-${row.batch_id}-${row.uom}`}><td>{row.location ?? "без зоны"}</td><td>{row.sku} {row.product}</td>
        <td>{row.batch}</td><td>{uomLabel[row.uom] ?? row.uom}</td><td>{countQuantity(row.quantity)}</td></tr>)}</tbody></table></div></details>}
    {sheet.can_manage && <form action={finishInventoryCountRound} className="inline-action"><input type="hidden" name="count_id" value={sheet.id}/>
      <PendingSubmitButton pendingText="Завершаем…" className="primary" type="submit">{round === 1 ? "Завершить подсчёт" : "Завершить повторный подсчёт"}</PendingSubmitButton>
      <small>{round === 1 ? "Места без записей считаются пустыми: учётный остаток на них станет недостачей." : "Все позиции списка должны быть пересчитаны."}</small></form>}
  </section>;
}

function Review({ sheet, review }: { sheet: CountSheet; review: CountReview }) {
  const editable = review.status === "review" && review.can_approve;
  const surpluses = review.lines.filter(line => line.kind === "surplus" || line.kind === "unknown_batch");
  const label = (line: ReviewLine) => `${line.location ?? "без зоны"} · ${line.sku} · ${line.batch ?? "не определена"}`;
  return <section className="panel admin-section" id="review">
    <div className="panel-heading"><div><p className="eyebrow">Учёт против подсчёта</p><h2>Разбор расхождений</h2></div>
      <span className={`page-count${review.totals.problems ? " receivable-overdue" : ""}`}>{review.totals.problems ? `нерешённых: ${review.totals.problems}` : "всё решено"}</span></div>
    <section className="shipment-summary-grid">
      <article className="summary-card"><p>Недостача</p><strong>{countQuantity(review.totals.shortage_pieces)} шт.</strong><small>{review.cost ? `${countMoney(review.totals.shortage_kzt)} KZT по себестоимости` : "суммы — с правом на закупочные цены"}</small></article>
      <article className="summary-card"><p>Излишек</p><strong>{countQuantity(review.totals.surplus_pieces)} шт.</strong><small>{review.cost ? `${countMoney(review.totals.surplus_kzt)} KZT` : ""}</small></article>
      <article className="summary-card"><p>Строк</p><strong>{review.totals.lines}</strong><small>совпало {review.totals.matches} · недостач {review.totals.shortages} · излишков {review.totals.surpluses} · не определено {review.totals.unknown}{review.cost && review.totals.no_cost_lines ? ` · без себестоимости ${review.totals.no_cost_lines}` : ""}</small></article>
    </section>
    <p className="form-help">У каждой недостачи — причина из справочника потерь. Недостачу рядом с излишком другого товара можно связать как пересорт. Для товара без партии выберите партию или «не учитывать». Если после списания остаток станет меньше резерва заказов, сначала снимите или замените резерв.</p>
    <div className="import-table-wrap"><table className="import-table">
      <thead><tr><th>Место</th><th>Товар и партия</th><th>Учёт</th><th>Подсчёт</th><th>Итог</th><th>Разница</th>{review.cost && <th>KZT</th>}<th>Вид и решение</th></tr></thead>
      <tbody>{review.lines.filter(line => line.kind !== "match").map(line => <tr key={line.id} className={line.problem ? "has-error" : ""}>
        <td>{line.location ?? "без зоны"}</td>
        <td>{line.sku} {line.product}<br/><small>{line.batch ?? "партия не определена"}{line.expiry_date ? ` · до ${line.expiry_date}` : ""} · {uomLabel[line.uom] ?? line.uom}</small></td>
        <td>{countQuantity(line.book)}{Number(line.reserved) ? <><br/><small>резерв {countQuantity(line.reserved)}</small></> : null}</td>
        <td>{countQuantity(line.counted)}{line.recount != null ? <><br/><small>повторно {countQuantity(line.recount)}</small></> : null}</td>
        <td>{countQuantity(line.final)}</td><td><strong>{Number(line.difference) > 0 ? "+" : ""}{countQuantity(line.difference)}</strong></td>
        {review.cost && <td>{line.difference_kzt == null ? <small>нет себестоимости</small> : countMoney(line.difference_kzt)}</td>}
        <td>{lineKindLabel[line.kind]}{line.other_location ? " · другое место" : ""}
          {line.reason && <><br/><small>{line.reason}</small></>}
          {line.assigned_batch && <><br/><small>партия {line.assigned_batch}</small></>}{line.ignored && <><br/><small>не учитывается</small></>}
          {line.problem && <><br/><small className="load-warning-text">{problemLabel[line.problem]}</small></>}
          {line.orders && line.orders.length > 0 && <><br/><small>резерв заказов: {line.orders.map(order => <Link key={order.sale_id} href={`/sales/${order.sale_id}`}>{order.sale_number} </Link>)}</small></>}
          {editable && line.kind === "shortage" && <>
            <form action={setInventoryCountDecision} className="inline-action"><input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="line_id" value={line.id}/>
              <select name="reason_code" defaultValue={line.reason_code ?? ""} required aria-label="Причина недостачи"><option value="" disabled>Причина</option>
                {review.reasons.map(reason => <option key={reason.code} value={reason.code}>{reason.name}</option>)}</select>
              <PendingSubmitButton pendingText="…" className="ghost" type="submit">Сохранить</PendingSubmitButton></form>
            {surpluses.length > 0 && <form action={pairInventoryCountLines} className="inline-action"><input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="line_id" value={line.id}/>
              <select name="pair_line_id" defaultValue={line.pair_line_id ?? ""} aria-label="Пересорт с излишком"><option value="">Без пары</option>
                {surpluses.map(other => <option key={other.id} value={other.id}>Пересорт с: {label(other)}</option>)}</select>
              <PendingSubmitButton pendingText="…" className="ghost" type="submit">Связать</PendingSubmitButton></form>}</>}
          {editable && line.kind === "unknown_batch" && <form action={setInventoryCountDecision} className="inline-action">
            <input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="line_id" value={line.id}/>
            <select name="assigned_batch_id" defaultValue={line.ignored ? "ignore" : line.assigned_batch_id ?? ""} required aria-label="Партия"><option value="" disabled>Партия</option>
              {(line.batches ?? []).map(batch => <option key={batch.id} value={batch.id}>{batch.batch}{batch.expiry_date ? ` · до ${batch.expiry_date}` : ""}</option>)}
              <option value="ignore">Не учитывать</option></select>
            <PendingSubmitButton pendingText="…" className="ghost" type="submit">Сохранить</PendingSubmitButton></form>}
          {line.pair_line_id && <><br/><small>пара: {(() => { const other = review.lines.find(item => item.id === line.pair_line_id); return other ? label(other) : "—"; })()}</small></>}
        </td></tr>)}</tbody></table></div>
    {review.lines.every(line => line.kind === "match") && <p className="empty-state">Расхождений нет: проведение ничего не изменит в остатках.</p>}
    <div className="import-table-wrap"><table className="import-table"><caption>По причинам</caption>
      <thead><tr><th>Причина</th><th>Строк</th><th>Штук</th>{review.cost && <th>KZT</th>}</tr></thead>
      <tbody>{review.by_reason.map(item => <tr key={item.reason_code ?? "none"}><td>{item.reason ?? (item.reason_code === "surplus" ? "Излишек" : item.reason_code === "unknown_batch" ? "Партия не определена" : "Причина не выбрана")}</td>
        <td>{item.lines}</td><td>{countQuantity(item.pieces)}</td>{review.cost && <td>{countMoney(item.kzt)}</td>}</tr>)}</tbody></table></div>
    <div className="import-table-wrap"><table className="import-table"><caption>По местам</caption>
      <thead><tr><th>Место</th><th>Строк с разницей</th><th>Недостача, шт.</th><th>Излишек, шт.</th>{review.cost && <><th>Недостача, KZT</th><th>Излишек, KZT</th></>}</tr></thead>
      <tbody>{review.by_location.map(item => <tr key={item.location_id ?? "none"}><td>{item.location ?? "без зоны"}</td><td>{item.lines}</td>
        <td>{countQuantity(item.shortage_pieces)}</td><td>{countQuantity(item.surplus_pieces)}</td>
        {review.cost && <><td>{countMoney(item.shortage_kzt)}</td><td>{countMoney(item.surplus_kzt)}</td></>}</tr>)}</tbody></table></div>
    {editable && review.digest && <form action={postInventoryCount} className="inline-action"><input type="hidden" name="count_id" value={sheet.id}/><input type="hidden" name="digest" value={review.digest}/>
      <PendingSubmitButton pendingText="Проводим…" className="primary" type="submit" disabled={review.totals.problems > 0}>Провести инвентаризацию</PendingSubmitButton>
      <small>Остатки изменит один документ корректировки. Если данные изменились после открытия страницы, проведение откажет — откройте разбор заново.</small></form>}
  </section>;
}

function Cancel({ sheet }: { sheet: CountSheet }) {
  if (sheet.status === "cancelled") return null;
  const allowed = sheet.status === "posted" ? sheet.can_approve : sheet.can_manage;
  if (!allowed) return null;
  return <details className="panel admin-section"><summary>{sheet.status === "posted" ? "Отменить проведённую инвентаризацию" : "Отменить инвентаризацию"}</summary>
    <form action={cancelInventoryCount} className="reference-form"><input type="hidden" name="count_id" value={sheet.id}/>
      <label className="wide-field">Причина<input name="reason" required minLength={3} maxLength={500}/></label>
      <PendingSubmitButton pendingText="Отменяем…" className="ghost" type="submit">Отменить</PendingSubmitButton>
      <small className="wide-field">{sheet.status === "posted" ? "Документ корректировки будет сторнирован; если товар уже использован, сторно откажет." : "Остатки не менялись; блокировка мест снимается."}</small>
    </form></details>;
}

