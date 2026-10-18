import { compareCommodities, isCommodityLine, type CommodityInvoice, type ShipmentCommodity } from "@/lib/document-extraction/commodity-evidence";

export function CustomsEvidence({ value, invoices = [], shipment = [], current = false }: { value: unknown; invoices?: CommodityInvoice[]; shipment?: ShipmentCommodity[]; current?: boolean }) {
  if (!value || typeof value !== "object" || !("fields" in value) || !Array.isArray(value.fields)) return null;
  if (!current) return <p className="login-error">Сверка недоступна: проверьте текущую версию, доступ и действующую привязку документа. Сохранённые реквизиты не показаны.</p>;
  const fields = value.fields.filter((field): field is { label: string; value: string } => Boolean(field && typeof field.label === "string" && typeof field.value === "string"));
  const warnings = "warnings" in value && Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [];
  const items = "items" in value && Array.isArray(value.items) && value.items.every(isCommodityLine) ? value.items : [];
  const currency = "currency" in value && typeof value.currency === "string" ? value.currency : null;
  const refs = "invoiceNumbers" in value && Array.isArray(value.invoiceNumbers) ? value.invoiceNumbers.filter((n): n is string => typeof n === "string") : [];
  const linkedInvoices = refs.length === 1 ? invoices.filter(invoice => invoice.number === refs[0]) : [];
  const comparisons = current ? compareCommodities(items, currency, linkedInvoices, shipment) : [];
  const num = (n: number | null) => n === null ? "не прочитано" : n.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
  return <div className="setup-notice" style={{ contain: "inline-size", minWidth: 0 }}>
    <h4>{"kind" in value && value.kind === "declaration" ? "Реквизиты таможенной декларации" : "Расчёт таможенных начислений"}</h4>
    <dl>{fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd><strong>{field.value}</strong></dd></div>)}</dl>
    {warnings.map((warning, index) => <p key={index}>{warning}</p>)}
    {items.length > 0 && <>
      <h4>Товарные строки ДТ: {items.length}. Сверка с инвойсом и поставкой</h4>
      <p>Связь только по точному артикулу. Количества сравниваются в одинаковых единицах; веса показаны отдельно. Разделённые позиции поставки суммируются по артикулу. Это не подтверждение фактической приёмки.</p>
      <p>Инвойс по графе 44 ДТ: {refs.join(", ") || "ссылка не прочитана"}. Сверка требует одного доступного актуального инвойса с этим номером.</p>
      {current && <>
        <p>ДТ ↔ инвойс: совпали артикул, количество и сумма в {comparisons.filter(c => c.invoiceMatched).length} из {items.length} строк. ДТ ↔ заказанное количество поставки: совпало в {comparisons.filter(c => c.orderedMatched).length} из {items.length} строк.</p>
        <p>Строк без замечаний: {comparisons.filter(c => c.status === "matched").length}; расхождения: {comparisons.filter(c => c.status === "different").length}; нужна проверка или заполнение данных: {comparisons.filter(c => c.status === "review").length}.</p>
      </>}
      <div className="table-wrap"><table className="data-table"><caption>ДТ → инвойс → поставка (только чтение)</caption><thead><tr><th>Товар ДТ</th><th>Количество / стоимость</th><th>Вес / таможенная стоимость</th><th>Инвойс</th><th>Поставка</th></tr></thead><tbody>{items.map((item, index) => <tr key={index}>
        <td>№ {item.number} · {item.sku ?? "артикул не прочитан"}<br/>{item.description}<br/>ТН ВЭД: {item.hsCode ?? "—"}{item.warnings.map((warning, n) => <p key={n}>{warning}</p>)}</td>
        <td>{num(item.quantity)} {item.unit ?? ""}<br/>{num(item.amount)} {currency ?? "валюта не определена"}</td>
        <td>Брутто: {num(item.grossKg)} кг<br/>Нетто: {num(item.netKg)} кг<br/>Гр. 45: {num(item.customsValue)}</td>
        <td>{comparisons[index]?.invoice ?? "Сверка недоступна"}</td><td>{comparisons[index]?.shipment ?? "Сверка недоступна"}</td>
      </tr>)}</tbody></table></div>
      {current && linkedInvoices.length === 1 && <p>Артикулы инвойса вне распознанных строк ДТ: {linkedInvoices[0].items.filter(line => !items.some(item => item.sku === line.sku)).map(line => line.sku ?? "не прочитан").join(", ") || "нет"}.</p>}
      {current && <p>Артикулы поставки вне распознанных строк ДТ: {[...new Set(shipment.filter(line => !items.some(item => item.sku === line.sku)).map(line => line.sku ?? "не прочитан"))].join(", ") || "нет"}.</p>}
    </>}
    <p>Только результат чтения для сверки с оригиналом. Эти реквизиты не записываются автоматически в поставку, себестоимость или платежи.</p>
  </div>;
}
