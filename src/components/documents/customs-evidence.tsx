import { compareCommodities, isCommodityLine, type CommodityInvoice, type ShipmentCommodity } from "@/lib/document-extraction/commodity-evidence";
import { evidenceOutcome } from "@/lib/document-check/evidence-outcome";
import { comparePackingQuantities, comparePackingItems, type PackingEvidence } from "@/lib/document-extraction/packing-evidence";
import type { mappedEvidence } from "@/lib/document-extraction/customs-matches";
import type { buildShipmentDocumentReadiness } from "@/lib/templates/readiness";

export function CustomsEvidence({ value, invoices = [], shipment = [], current = false, reviewed = false, packing = [], readiness, mapped }: { value: unknown; invoices?: CommodityInvoice[]; shipment?: ShipmentCommodity[]; current?: boolean; reviewed?: boolean; packing?: PackingEvidence[]; readiness?: ReturnType<typeof buildShipmentDocumentReadiness> | null; mapped?: ReturnType<typeof mappedEvidence> }) {
  if (!value || typeof value !== "object" || !("fields" in value) || !Array.isArray(value.fields)) return null;
  if (!current) return <p className="login-error">Сверка недоступна: проверьте текущую версию, доступ и действующую привязку документа. Сохранённые реквизиты не показаны.</p>;
  const fields = value.fields.filter((field): field is { label: string; value: string } => Boolean(field && typeof field.label === "string" && typeof field.value === "string"));
  const warnings = "warnings" in value && Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [];
  const items = "items" in value && Array.isArray(value.items) && value.items.every(isCommodityLine) ? value.items : [];
  const currency = "currency" in value && typeof value.currency === "string" ? value.currency : null;
  const refs = "invoiceNumbers" in value && Array.isArray(value.invoiceNumbers) ? value.invoiceNumbers.filter((n): n is string => typeof n === "string") : [];
  const comparisonItems=mapped?.items ?? items;
  const linkedInvoices = mapped ? [mapped.invoice] : refs.length === 1 ? invoices.filter(invoice => invoice.number === refs[0]) : [];
  const comparisons = current ? compareCommodities(comparisonItems, currency, linkedInvoices, shipment) : [];
  const validationWarnings = ("validationWarnings" in value && Array.isArray(value.validationWarnings) ? value.validationWarnings.filter((w): w is string => typeof w === "string") : warnings).filter(w=>!(mapped&&mapped.items.every(i=>!i.warnings.length)&&w==="Есть строки, требующие проверки по оригиналу."));
  const extraInvoiceItems = linkedInvoices.length !== 1 || linkedInvoices[0].items.some(line => !comparisonItems.some(item => item.sku === line.sku));
  const incomplete = !("expectedCount" in value) || value.expectedCount !== items.length || extraInvoiceItems;
  const outcome = evidenceOutcome(comparisons, current, reviewed, [...validationWarnings, ...(incomplete ? ["Неполный состав строк"] : [])]);
  const packingRefs = "packingNumbers" in value && Array.isArray(value.packingNumbers) ? value.packingNumbers.filter((n): n is string => typeof n === "string") : [];
  const packingOutcome = mapped ? comparePackingItems(comparisonItems,[mapped.packing]) : comparePackingQuantities(items, packingRefs, packing);
  const num = (n: number | null) => n === null ? "не прочитано" : n.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
  return <div className="setup-notice" style={{ contain: "inline-size", minWidth: 0 }}>
    <h4>{"kind" in value && value.kind === "declaration" ? "Реквизиты таможенной декларации" : "kind" in value && value.kind === "value_declaration" ? "Декларация таможенной стоимости (ДТС)" : "kind" in value && value.kind === "transit" ? "Транзитная декларация" : "Расчёт таможенных начислений"}</h4>
    {"kind" in value && (value.kind === "value_declaration" || value.kind === "transit") && <p><strong>{!current ? "Версия или привязка устарела: требуется повторная сверка" : reviewed ? "Показанные реквизиты сверены с оригиналом" : "Показанные реквизиты ожидают ручной сверки"}</strong>. Это не подтверждение приёмки, оплаты или выпуска товара.</p>}
    <dl>{fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd><strong>{field.value}</strong></dd></div>)}</dl>
    {warnings.map((warning, index) => <p key={index}>{warning}</p>)}
    {"kind" in value && value.kind === "declaration" && <div className="evidence-outcomes" aria-label="Три независимых результата проверки">
        <section><h4>1. Проверка чтения</h4><p>{outcome.reading}.</p><p>Подтверждение чтения не означает совпадение с заказом или фактическую приёмку.</p></section>
        <section><h4>2. Согласованность данных</h4><p>{outcome.comparison}.</p>
          <p>Основа сверки отгрузки — актуальные подтверждённые инвойс и упаковочный лист. Первоначальный заказ отражает потребность и сохраняется для сравнения.</p>
          {outcome.differences.length > 0 && <><strong>Информация: отличие от первоначального заказа</strong><ul>{outcome.differences.map((text, index) => <li key={index}>{text}</li>)}</ul><p>Отличие от потребности не считается ошибкой сверки или складской недостачей. Причина изменения количества поставщиком документами не установлена.</p></>}
          <p>{packingOutcome.message}.</p>
          {packingOutcome.differences.length > 0 && <ul>{packingOutcome.differences.map(text => <li key={text}>{text}</li>)}</ul>}
          <p>Ссылка на упаковочный лист в графе 44: {packingRefs.join(", ") || "не прочитана"}. Сравнение количества не подтверждает приёмку. Итог по реквизитам показан в блоке «Сверка».</p>
        </section>
        <section><h4>3. Готовность нового комплекта</h4>
          <p>{!readiness ? "Нет доступного предварительного расчёта готовности" : readiness.ready ? "Общие обязательные реквизиты заполнены" : `Не заполнено обязательных реквизитов: ${readiness.requiredMissing}`}.</p>
          {readiness && !readiness.ready && <ul>{readiness.items.filter(item => item.required && !item.ready).map(item => <li key={item.key}>{item.label}</li>)}</ul>}
          <p>Используется та же проверка, что в блоке «Готовность документов перевозки». Окончательная проверка выполняется для выбранного шаблона и автомобиля перед формированием. Подтверждение чтения её не заменяет.</p>
        </section>
      </div>}
    {items.length > 0 && <>
      <h4>Товарные строки ДТ: {items.length}. Сверка с инвойсом и поставкой</h4>
      <p>{mapped ? "Использовано явное сопоставление сотрудника с текущими инвойсом и упаковочным листом. Артикулы оригинала не изменены." : "Связь по точному артикулу; если его нет в оригинале, заполните явное сопоставление ниже."} Количества сравниваются в одинаковых единицах; веса показаны отдельно. Разделённые позиции поставки суммируются по артикулу. Это не подтверждение фактической приёмки.</p>
      <p>Инвойс по графе 44 ДТ: {refs.join(", ") || "ссылка не прочитана"}. Сверка требует одного доступного актуального подтверждённого инвойса с этим номером и подтверждённого упаковочного листа.</p>
      {current && <>
        <p>ДТ ↔ подтверждённый инвойс: совпали артикул, количество и сумма в {comparisons.filter(c => c.invoiceMatched).length} из {items.length} строк.</p>
        <p>Справочно, ДТ ↔ первоначальный заказ: совпало в {comparisons.filter(c => c.orderedMatched).length} из {items.length} строк. Отличия от заказа не включаются в счётчик расхождений.</p>
        <p>По ДТ, инвойсу и карточке поставки — строк без замечаний: {comparisons.filter(c => c.status === "matched").length}; расхождения: {comparisons.filter(c => c.status === "different").length}; нужна проверка или заполнение данных: {comparisons.filter(c => c.status === "review").length}. Упаковочный лист проверяется отдельно выше.</p>
      </>}
      <div className="table-wrap"><table className="data-table"><caption>ДТ → инвойс → поставка (только чтение)</caption><thead><tr><th>Товар ДТ</th><th>Количество / стоимость</th><th>Вес / таможенная стоимость</th><th>Инвойс</th><th>Поставка</th></tr></thead><tbody>{items.map((item, index) => <tr key={index}>
        <td>№ {item.number} · {item.sku ?? "артикул в оригинале не определён"}{mapped&&<p><strong>Товар Nexus по сопоставлению: {comparisonItems[index]?.sku}</strong></p>}<br/>{item.description}<br/>ТН ВЭД: {item.hsCode ?? "—"}{item.warnings.map((warning, n) => <p key={n}>{warning}</p>)}</td>
        <td>{num(item.quantity)} {item.unit ?? ""}<br/>{num(item.amount)} {currency ?? "валюта не определена"}</td>
        <td>Брутто: {num(item.grossKg)} кг<br/>Нетто: {num(item.netKg)} кг<br/>Гр. 45: {num(item.customsValue)}</td>
        <td>{comparisons[index]?.invoice ?? "Сверка недоступна"}</td><td>{comparisons[index]?.shipment ?? "Сверка недоступна"}</td>
      </tr>)}</tbody></table></div>
      {current && linkedInvoices.length === 1 && <p>Артикулы инвойса вне строк ДТ с учётом сопоставления: {linkedInvoices[0].items.filter(line => !comparisonItems.some(item => item.sku === line.sku)).map(line => line.sku ?? "не прочитан").join(", ") || "нет"}.</p>}
      {current && <p>Артикулы поставки вне строк ДТ с учётом сопоставления: {[...new Set(shipment.filter(line => !comparisonItems.some(item => item.sku === line.sku)).map(line => line.sku ?? "не прочитан"))].join(", ") || "нет"}.</p>}
    </>}
    <p>Только результат чтения для сверки с оригиналом. Эти реквизиты не записываются автоматически в поставку, себестоимость или платежи.</p>
  </div>;
}
