import Link from "next/link";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import type { CustomsIssue, Distribution, DistributionLine, StickerLine } from "@/lib/shipments/order-workbook-extra";
import { createDistributionOrders } from "./actions";

const num = (value: number | null | undefined) => value === null || value === undefined ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);

export function CustomsCheck({ lines, issues }: { lines: number; issues: CustomsIssue[] }) {
  return <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Лист «Растаможка» · только проверка</p><h2>Сверка для растаможки</h2></div></div>
    {!lines ? <p className="form-help">Лист «Растаможка» пуст или не найден.</p> : !issues.length ? <p className="login-success">Все {lines} строк совпадают с карточками товаров и позициями поставки: ТН ВЭД, страна, количество и цена.</p> : <>
      <p className="form-help">Строк в листе: {lines}. Расхождения ниже исправляются в карточке товара, в позиции поставки или в самой таблице — Nexus их сам не меняет.</p>
      <div className="compact-list">{issues.map((issue, index) => <div className="shipment-row" key={`${issue.row}-${issue.field}-${index}`}>
        <div><strong>Строка {issue.row}: {issue.article}</strong><small>{issue.field}</small></div>
        <div><strong>В таблице: {issue.sheet}</strong><small>В Nexus: {issue.nexus}</small></div>
      </div>)}</div></>}
  </section>;
}

export type StickerRow = StickerLine & { product: string | null; requiresSticker: boolean | null; unitTemplate: boolean; boxTemplate: boolean };
export function StickerCheck({ rows, size, marking, templatesVisible }: { rows: StickerRow[]; size: string | null; marking: string | null; templatesVisible: boolean }) {
  return <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Лист «Стикеры» · только проверка</p><h2>Стикеры</h2></div></div>
    {!rows.length ? <p className="form-help">Лист «Стикеры» пуст или не найден.</p> : <>
      <p className="form-help">Размер: {size ?? "—"} · {marking ?? "—"}. Всего индивидуальных: {num(rows.reduce((sum, row) => sum + row.unitStickers, 0))}, коробочных: {num(rows.reduce((sum, row) => sum + row.boxStickers, 0))}. Заказ стикеров оформляется на этапе «Стикеровка» по утверждённым макетам.</p>
      <div className="compact-list">{rows.map(row => <div className="shipment-row" key={row.row}>
        <div><strong>Строка {row.row}: {row.sku || row.ean}</strong><small>{row.product ?? "товар не найден в справочнике"}</small></div>
        <div><strong>{num(row.unitStickers)} индивидуальных · {num(row.boxStickers)} коробочных</strong>
          <small>{row.requiresSticker === false ? "В карточке товара стикер не требуется — проверьте карточку" : !templatesVisible ? "Макеты: нет права просмотра" : `Утверждённый макет: штучный — ${row.unitTemplate ? "есть" : "нет"}, коробочный — ${row.boxTemplate ? "есть" : "нет"}`}</small></div>
      </div>)}</div></>}
  </section>;
}

export type SaleTarget = { column: number; label: string; customerId: string | null; existing: { saleId: string; number: string } | null; currencyId: string; items: { productId: string; quantity: number }[]; unmatched: number };
export function DistributionView({ shipmentId, file, source, sourceName, distribution, over, productOf, sales, customers, currencies, defaultDate, canOrder }: {
  shipmentId: string; file: string; source: string; sourceName: string; distribution: Distribution; over: DistributionLine[]; productOf: (line: DistributionLine) => string | null;
  sales: SaleTarget[]; customers: { id: string; name: string }[]; currencies: { id: string; code: string }[]; defaultDate: string; canOrder: boolean;
}) {
  const open = sales.filter(sale => !sale.existing && sale.items.length);
  return <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">{sourceName}</p><h2>Распределение по клиентам и складам</h2></div></div>
    {!distribution.destinations.length ? <p className="form-help">Распределение не заполнено: в таблице нет столбцов «Заказ, шт» под клиентами или складами.</p> : <>
      {over.length > 0 && <div className="login-error admin-message">Распределено больше, чем пришло: строки {over.map(line => line.row).join(", ")}. Исправьте таблицу распределения.</div>}
      <div className="compact-list">{distribution.lines.map(line => <div className="shipment-row" key={line.row}>
        <div><strong>{line.orderCode || "—"} · {line.sku || line.factorySku || line.ean}</strong><small>{productOf(line) ?? "товар не найден в справочнике"}</small></div>
        <div><strong>Приход: {num(line.received)} шт</strong><small>{distribution.destinations.filter(item => line.quantities[item.column]).map(item => `${item.name}: ${num(line.quantities[item.column])}`).join(" · ") || "не распределено"}</small></div>
      </div>)}</div>
      {distribution.destinations.some(item => item.kind === "warehouse") && <p className="form-help">Склады ({distribution.destinations.filter(item => item.kind === "warehouse").map(item => item.name).join(", ")}): перемещение оформляется после приёмки, здесь не создаётся.</p>}
      {sales.length > 0 && <form action={createDistributionOrders} className="compact-list">
        <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="file" value={file}/><input type="hidden" name="source" value={source}/>
        <h3>Черновики заказов клиентов</h3>
        <p className="form-help">Один заказ на клиента: товары и количества из распределения, цены — из прайса на дату заказа (как при пустой цене в форме заказа), склад — склад назначения поставки. Заказ создаётся черновиком; проверьте его в «Продажах».</p>
        {sales.map(sale => <div className="form-grid" key={sale.column}>
          <strong>{sale.label}</strong>
          {sale.existing ? <p>Заказ уже создан: <Link href={`/sales/${sale.existing.saleId}`}>{sale.existing.number}</Link></p> : !sale.items.length ? <p>Нет сопоставленных товаров.</p> : <>
            <label className="check-label"><input type="checkbox" name="order" value={sale.column} defaultChecked={Boolean(sale.customerId)} disabled={!canOrder}/> Создать ({sale.items.length} строк{sale.unmatched ? `, не сопоставлено: ${sale.unmatched}` : ""})</label>
            <label>Клиент<select name={`customer:${sale.column}`} defaultValue={sale.customerId ?? ""} disabled={!canOrder}><option value="">Выберите клиента</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <label>Валюта<select name={`currency:${sale.column}`} defaultValue={sale.currencyId} disabled={!canOrder}>{currencies.map(currency => <option key={currency.id} value={currency.id}>{currency.code}</option>)}</select></label>
            <label>Плановая отгрузка<input type="date" name={`date:${sale.column}`} defaultValue={defaultDate} min={defaultDate} disabled={!canOrder}/></label>
            <input type="hidden" name={`items:${sale.column}`} value={JSON.stringify(sale.items)}/></>}
        </div>)}
        {!canOrder ? <p className="setup-notice">Для создания заказов нужно право «Клиентские заказы: изменение».</p> : open.length > 0 && <>
          <label className="check-label"><input type="checkbox" name="confirm" value="yes" required/> Проверил(а) клиентов и количества. Создать отмеченные черновики</label>
          <PendingSubmitButton pendingText="Создаём…" className="primary" type="submit">Создать черновики заказов</PendingSubmitButton></>}
      </form>}
    </>}
  </section>;
}
