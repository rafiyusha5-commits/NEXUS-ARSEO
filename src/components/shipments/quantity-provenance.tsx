import { DocumentActions } from "@/components/documents/document-actions";
import type { DocumentActionIndex } from "@/lib/documents/action-index";
import { quantityDifferences, quantitySource, type QuantityProvenance, type QuantityEvent } from "@/lib/shipments/quantity-provenance";

const units: Record<string, string> = { piece: "шт.", box: "кор.", kg: "кг", layer: "слой", pallet: "пал." };
const n = (value: number | null) => value === null ? "Не установлено" : value.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
const date = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(value));
const missing = "Источник не зафиксирован";
function Source({ event, index }: { event: QuantityEvent | null; index: DocumentActionIndex }) {
  return event ? <span className="quantity-source">{event.document} · версия {event.version}{!event.currentVersion && " (историческая, не текущая)"}<br/>
    Количество подтвердил: {event.actor ?? "Сотрудник не доступен"} · {date(event.at)}<br/>
    {!event.reviewed && "Текущее подтверждение чтения не установлено. "}Запись истории {event.id}<DocumentActions document={index[event.documentId]} version={event.version}/></span> : <span className="quantity-source">{missing}</span>;
}
export function QuantityProvenanceView({ data, documentActions = {} }: { data: QuantityProvenance; documentActions?: DocumentActionIndex }) {
  return <section className="panel admin-section quantity-provenance" aria-label="Откуда взялось количество">
    <div className="panel-heading"><div><p className="eyebrow">Только просмотр · без проведения операций</p><h2>Откуда взялось количество</h2></div></div>
    <p className="form-help">Потребность, подтверждение поставщика, документы и приёмка — разные основания. Изменение относительно заказа не является складской недостачей. Показаны только доступные источники; отсутствие источника не означает отсутствие документа.</p>
    {!data.auditVisible && <p className="setup-notice">История первоначальной потребности недоступна с текущими правами. Текущая потребность не выдаётся за первоначальную.</p>}
    {!data.inventoryVisible && <p className="setup-notice">Данные и основания приёмки недоступны с текущими правами.</p>}
    {data.items.map(item => {
      const unit = units[item.uom] ?? item.uom;
      const original = item.demandHistory.find(event => event.action === "insert");
      const differences = quantityDifferences(item);
      return <article className="quantity-lineage-item" key={item.id}>
        <h3>{item.sku} · {item.name?.ru ?? item.name?.en ?? "Товар"}</h3>
        <p className="form-help">{item.transport === null ? "Не распределено" : `Автомобиль №${item.transport}`} · единица позиции: {unit}</p>
        <dl className="quantity-lineage-grid">
          <div><dt>Первоначальная потребность</dt><dd>{original ? `${n(original.quantity)} ${units[original.uom] ?? original.uom}` : "Не установлено"}</dd><small>{original ? `При создании этой позиции · ${original.actor ?? "Сотрудник не доступен"} · ${date(original.at)} · запись ${original.id}` : missing}</small></div>
          <div><dt>Текущая потребность</dt><dd>{n(item.ordered)} {unit}</dd><small>Записано в позиции заказа. Разделённые позиции показаны отдельно, без восстановления общего первоначального заказа.</small></div>
          <div><dt>Подтверждено поставщиком</dt><dd>{n(item.confirmed)}{item.confirmed !== null && ` ${unit}`}</dd><Source index={documentActions} event={quantitySource(item, "confirmed")}/></div>
          <div><dt>Отгружено по документам</dt><dd>{n(item.shipped)}{item.shipped !== null && ` ${unit}`}</dd><Source index={documentActions} event={quantitySource(item, "shipped")}/></div>
          {data.inventoryVisible && <div><dt>Фактически принято (включая повреждение)</dt><dd>{n(item.received)}{item.received !== null && ` ${unit}`}</dd><small>{item.receipts.length ? "Основание — записи приёмки ниже" : missing}</small></div>}
        </dl>
        <div className="quantity-differences">
          <p>Подтверждение к текущей потребности: <strong>{n(differences.supplierVsDemand)}{differences.supplierVsDemand !== null && ` ${unit}`}</strong>. Информационное изменение, причина не установлена.</p>
          {data.inventoryVisible && <p>Приёмка к отгруженному: <strong>{n(differences.receiptVsShipped)}{differences.receiptVsShipped !== null && ` ${unit}`}</strong>. Не заменяет оформленные повреждение, недостачу или излишек.</p>}
        </div>
        {item.receipts.map(receipt => <div className="quantity-receipt" key={receipt.id}>
          <strong>Запись приёмки · {date(receipt.at)}</strong>
          <p>Ожидалось {n(receipt.expected)} · годное {n(receipt.accepted)} · повреждение {n(receipt.damaged)} · недостача {n(receipt.shortage)} · излишек {n(receipt.overage)} {unit}</p>
          <p>{receipt.actor ?? "Сотрудник не доступен"} · исполнитель: {receipt.performedBy} · запись {receipt.id}</p>
          <p>Причина: {receipt.reason ?? "не зафиксирована"}. Связь с документом приёмки: {missing.toLowerCase()}.</p>
        </div>)}
        <details className="quantity-timeline"><summary>Последовательность сохранённых изменений</summary>
          <p className="form-help">Не восстановленная задним числом история. Журнал подтверждений не хранит отдельный снимок единицы или причину. Недоступные источники не перечисляются.</p>
          {!item.history.length && !item.demandHistory.length && <p>{missing}</p>}
          <ol>{item.demandHistory.map(event => <li key={`d-${event.id}`}>Потребность: {n(event.previous)} {units[event.previousUom ?? event.uom] ?? event.uom} → {n(event.quantity)} {units[event.uom] ?? event.uom}<br/>{event.actor ?? "Сотрудник не доступен"} · {date(event.at)} · запись {event.id}. Документ и причина: не зафиксированы.</li>)}</ol>
          <ol>{item.history.map(event => <li key={event.id}>{event.field === "confirmed" ? "Подтверждено" : "Отгружено"}: {n(event.previous)} → {n(event.quantity)}<br/><Source index={documentActions} event={event}/>Причина изменения: не зафиксирована.</li>)}</ol>
        </details>
      </article>;
    })}
    {!data.items.length && <p className="empty-state">Доступных позиций нет.</p>}
  </section>;
}
