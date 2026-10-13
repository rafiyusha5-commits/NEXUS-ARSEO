import type { ShipmentOutcome } from "@/lib/shipment-outcome";

const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "авто" };
const saleStatus: Record<string, string> = { draft: "Черновик", reserved: "Зарезервирован", confirmed: "Подтверждён", shipped: "Отгружен", cancelled: "Отменён" };
const batchStatus: Record<string, string> = { available: "Доступна", quarantine: "Карантин", blocked: "Заблокирована", depleted: "Израсходована" };
const shelfState: Record<string, string> = { expired: "Просрочена", below: "Ниже требований клиентов", soon: "Скоро ниже требований" };
const number = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
const money = (value: number) => value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(new Date(value.length === 10 ? `${value}T00:00:00Z` : value)) : "—";
const unitList = (rows: Array<{ uom: string; value: number }>) => rows.filter(row => row.value).map(row => `${number(row.value)} ${units[row.uom] ?? row.uom}`).join(" + ") || "0";

type ItemRef = { id: string; uom: string; product: unknown };

// The final part of the report: where the goods went, what they cost, the document check and shelf life.
export function ShipmentOutcomeSections({ outcome, items }: { outcome: ShipmentOutcome; items: ItemRef[] }) {
  const { summary } = outcome;
  const sum = (key: "received" | "issued" | "writtenOff" | "onHand" | "reserved") => unitList(summary.units.map(unit => ({ uom: unit.uom, value: unit[key] })));
  const shelf = outcome.shelfLife === "hidden" ? null : new Map(outcome.shelfLife.map(entry => [entry.batchId, entry]));
  const worstShelf = outcome.shelfLife === "hidden" ? null : outcome.shelfLife.find(entry => entry.state === "expired") ?? outcome.shelfLife.find(entry => entry.state === "below") ?? outcome.shelfLife[0] ?? null;
  const itemById = new Map(items.map(item => [item.id, item]));
  return <>
    <section className="panel admin-section" id="outcome"><div className="panel-heading"><div><p className="eyebrow">Итог поставки</p><h2>Весь путь товара</h2></div><span className="page-count">на {date(outcome.today)}</span></div>
      <div className="shipment-summary-grid report-summary outcome-summary">
        <article className="summary-card"><p>Принято на склад</p><strong>{outcome.inventoryVisible ? sum("received") : "—"}</strong><small>Партий: {summary.batches}</small></article>
        <article className="summary-card"><p>Отгружено и продано</p><strong>{outcome.inventoryVisible ? sum("issued") : "—"}</strong><small>Списано: {outcome.inventoryVisible ? sum("writtenOff") : "—"}</small></article>
        <article className="summary-card"><p>На складе</p><strong>{outcome.inventoryVisible ? sum("onHand") : "—"}</strong><small>В резерве: {outcome.inventoryVisible ? sum("reserved") : "—"}</small></article>
        <article className={`summary-card report-control ${summary.balanced ? "is-ok" : "has-warning"}`}><p>Движения и остатки</p><strong>{!outcome.inventoryVisible ? "Нет доступа" : !summary.batches ? "Нет партий" : summary.balanced ? "Сходятся" : "Есть расхождение"}</strong><small>Приход − расход = остаток по каждой партии</small></article>
        <article className="summary-card"><p>Себестоимость</p><strong>{outcome.cost === "hidden" ? "Нет доступа" : outcome.cost ? `${money(outcome.cost.landedTotal)} ${outcome.cost.currency ?? ""}` : "Не рассчитана"}</strong><small>{outcome.cost && outcome.cost !== "hidden" ? `Версия ${outcome.cost.version} · ${outcome.cost.status === "approved" ? `утверждена ${date(outcome.cost.approvedAt)}` : "черновик, не утверждена"}` : "Расчёт в разделе «Финансы»"}</small></article>
        <article className={`summary-card report-control ${outcome.documentCheck !== "hidden" && outcome.documentCheck.findings.length === 0 ? "is-ok" : "has-warning"}`}><p>«Сверка»</p><strong>{outcome.documentCheck === "hidden" ? "Нет доступа" : outcome.documentCheck.findings.length === 0 ? "Без замечаний" : `Ошибок: ${outcome.documentCheck.counts.errors} · предупреждений: ${outcome.documentCheck.counts.warnings}`}</strong><small>{outcome.documentCheck !== "hidden" && outcome.documentCheck.lastRunAt ? `Проверено ${date(outcome.documentCheck.lastRunAt)}` : "Проверка документов поставки"}</small></article>
        <article className={`summary-card report-control ${worstShelf ? "has-warning" : "is-ok"}`}><p>«Контроль ОСГ»</p><strong>{outcome.shelfLife === "hidden" ? "Нет доступа" : worstShelf ? shelfState[worstShelf.state] ?? worstShelf.state : "Риска нет"}</strong><small>{worstShelf?.firstDeadline ? `Продать до ${date(worstShelf.firstDeadline)}` : "Остаточный срок на 60 дней вперёд"}</small></article>
      </div>
    </section>

    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Продажи и отгрузки</p><h2>Куда ушли партии</h2></div><span className="page-count">{outcome.outcomes.length}</span></div>
      {!outcome.inventoryVisible && <p className="empty-state">Нет права просматривать склад: движение партий скрыто.</p>}
      {outcome.inventoryVisible && !outcome.outcomes.length && <p className="empty-state">Партии появятся после приёмки поставки на склад.</p>}
      {outcome.outcomes.length > 0 && <div className="import-table-wrap"><table className="import-table report-table outcome-table"><thead><tr><th>Партия</th><th>Срок годности · ОСГ</th><th>Принято</th><th>Отгружено</th><th>Списано</th><th>Корректировки</th><th>На складе</th><th>В резерве</th><th>Покупатели</th></tr></thead><tbody>
        {outcome.outcomes.map(entry => { const product = outcome.products.get(entry.batch.product_id); const risk = shelf?.get(entry.batch.id); return entry.flows.map((flow, index) => <tr key={`${entry.batch.id}-${flow.uom}`} className={flow.balanced ? "" : "has-error"}>
          {index === 0 && <td rowSpan={entry.flows.length}><strong>{entry.batch.batch_number}</strong><br/>{product?.internal_sku} {product?.name}<br/><small>{batchStatus[entry.batch.status] ?? entry.batch.status}</small></td>}
          {index === 0 && <td rowSpan={entry.flows.length}>{date(entry.batch.expiry_date)}<br/><small>ОСГ {entry.remainingPct === null ? "неизвестен" : `${entry.remainingPct.toLocaleString("ru-RU")}%`}{risk ? ` · ${shelfState[risk.state] ?? risk.state}` : ""}</small></td>}
          <td>{number(flow.received)} {units[flow.uom] ?? flow.uom}</td><td>{number(flow.issued)}</td><td>{number(flow.writtenOff)}</td>
          <td>{flow.adjustedIn || flow.adjustedOut ? `+${number(flow.adjustedIn)} / −${number(flow.adjustedOut)}` : "—"}</td>
          <td><strong>{number(flow.onHand)}</strong>{!flow.balanced && <small className="danger-text"> не сходится с движениями</small>}</td><td>{number(flow.reserved)}</td>
          {index === 0 && <td rowSpan={entry.flows.length}>{!outcome.salesVisible ? <small>Нет права просматривать заказы</small> : entry.customers.length ? entry.customers.map(customer => <div key={`${customer.saleId}-${customer.uom}`}><strong>{customer.saleNumber}</strong> · {customer.customerName ?? "клиент скрыт"}<br/><small>{saleStatus[customer.saleStatus] ?? customer.saleStatus} · {customer.fulfilled ? `отгружено ${number(customer.fulfilled)}` : `в резерве ${number(customer.reserved)}`} {units[customer.uom] ?? customer.uom}</small></div>) : <small>Заказов нет</small>}</td>}
        </tr>); })}
      </tbody></table></div>}
      <p className="form-help">Отгрузки клиентам и продажи учитываются по складским движениям «расход»; перемещения между складами не меняют итог. Строка подсвечивается, если приход минус расход не равен остатку.</p>
    </section>

    {outcome.cost !== "hidden" && <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Финансы</p><h2>Себестоимость</h2></div><span className="page-count">{outcome.cost ? `версия ${outcome.cost.version}` : "нет расчёта"}</span></div>
      {!outcome.cost && <p className="empty-state">Расчёт себестоимости ещё не выполнен.</p>}
      {outcome.cost && <><div className="operation-facts"><div><small>Товар</small><strong>{money(outcome.cost.goodsTotal)} {outcome.cost.currency}</strong></div><div><small>Расходы</small><strong>{money(outcome.cost.expensesTotal)} {outcome.cost.currency}</strong></div><div><small>Себестоимость поставки</small><strong>{money(outcome.cost.landedTotal)} {outcome.cost.currency}</strong></div><div><small>Статус</small><strong>{outcome.cost.status === "approved" ? `Утверждена ${date(outcome.cost.approvedAt)}` : "Черновик"}</strong></div></div>
        <div className="import-table-wrap"><table className="import-table report-table"><thead><tr><th>Позиция</th><th>Количество</th><th>Себестоимость позиции</th><th>За единицу</th></tr></thead><tbody>{outcome.cost.items.map(row => { const item = itemById.get(row.shipmentItemId); const product = item?.product as { internal_sku?: string } | Array<{ internal_sku?: string }> | null | undefined; const sku = Array.isArray(product) ? product[0]?.internal_sku : product?.internal_sku; return <tr key={row.shipmentItemId}><td>{sku ?? "—"}</td><td>{number(row.quantity)} {item ? units[item.uom] ?? item.uom : ""}</td><td>{money(row.landedAmount)}</td><td>{row.unitLandedCost.toLocaleString("ru-RU", { maximumFractionDigits: 4 })}</td></tr>; })}</tbody></table></div></>}
    </section>}

    {outcome.documentCheck !== "hidden" && <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Агент «Сверка»</p><h2>Итог сверки документов</h2></div><span className="page-count">{outcome.documentCheck.findings.length}</span></div>
      {outcome.documentCheck.findings.length === 0 ? <p className="empty-state">Замечаний по документам нет.</p> : <div className="report-list">{outcome.documentCheck.findings.map((finding, index) => <article key={index}><strong>{finding.severity === "error" ? "Ошибка" : "Предупреждение"}{finding.transport_no ? ` · автомобиль №${finding.transport_no}` : ""}</strong><span>{finding.message}</span>{finding.document_title && <small>{finding.document_title}</small>}</article>)}</div>}
    </section>}
  </>;
}
