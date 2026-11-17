import { PendingSubmitButton } from "@/components/pending-submit-button";
import { setCustomerMarginThreshold } from "@/app/sales/prices/actions";

// Margin of batches in stock (202611170300). Rendered only for employees with purchase-price access: the database
// functions refuse everybody else, so these components never receive cost or margin for them.

type Available = Array<{ uom: string; quantity: string }>;
type Margin = { price?: string | null; currency?: string | null; margin_pct?: string | number | null; markup_pct?: string | number | null; reason?: string | null; net_price?: string | number | null; cost?: string | number | null };
export type BatchMarginsData = {
  date: string;
  batches: Array<{ batch_id: string; batch_number: string; expiry_date: string; available: Available; cost_basis: string | null;
    unit_cost: string | null; cost_uom: string | null; cost_currency: string | null; margins: Record<string, Margin> }>;
};
export type CustomerMarginsData = {
  date: string; can_manage: boolean; threshold: string | null;
  history: Array<{ threshold: string | null; previous: string | null; reason: string; created_at: string; author: string | null }>;
  rows: Array<{ product_id: string; sku: string; product: string; batch_id: string; batch_number: string; expiry_date: string; available: Available;
    price: string | null; currency: string | null; price_source: string | null; margin_pct: string | null; markup_pct: string | null;
    reason: string | null; cost_basis: string | null; below: boolean }>;
};

const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
const MARGIN_REASONS: Record<string, string> = {
  no_cost: "себестоимость не утверждена", no_price: "нет цены", no_packaging: "нет упаковки для пересчёта",
  no_rate: "нет официального курса", no_vat_rate: "не задана ставка НДС",
  no_price_type: "у клиента не задан вид цены", currency_mismatch: "валюта не совпадает", fixed_price_currency: "фиксированная цена в другой валюте",
  no_brand: "бренд не в справочнике", invalid_uom: "неизвестная единица",
};
const number = (value: string | number | null | undefined, digits = 2) => value == null ? "" : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: digits });
const day = (value: string) => new Intl.DateTimeFormat("ru-RU").format(new Date(value));
const stock = (available: Available) => available.map(a => `${number(a.quantity, 3)} ${units[a.uom] ?? a.uom}`).join(", ");
const oldRule = (basis: string | null) => basis === "source_item" ? <><br/><small className="load-warning-text">себестоимость по первой поставке</small></> : null;

function MarginCell({ margin }: { margin: Margin | undefined }) {
  if (!margin) return <td>—</td>;
  if (margin.margin_pct == null) return <td><small>{MARGIN_REASONS[margin.reason ?? ""] ?? margin.reason ?? "—"}</small></td>;
  return <td>{number(margin.margin_pct)} %<br/><small>наценка {margin.markup_pct == null ? "—" : `${number(margin.markup_pct)} %`}</small></td>;
}

/** Price list, one product: every batch in stock in shipping order and its margin at each price type (reference). */
export function BatchMargins({ data, types }: { data: BatchMarginsData; types: Array<{ code: string; name: string }> }) {
  const shown = types.filter(type => data.batches.some(batch => batch.margins[type.code]));
  return <section className="panel admin-section">
    <div className="panel-heading"><div><p className="eyebrow">Только с правом на закупочные цены</p><h2>Маржа по партиям на {day(data.date)}</h2></div></div>
    <p className="form-help">Маржа — доля прибыли в цене без НДС: (цена без НДС − себестоимость) / цена без НДС. Наценка — та же разница к себестоимости. Цена прайса без процентов клиентов; себестоимость партии пересчитана по официальному курсу на дату. Справочно, порог здесь не применяется.</p>
    {data.batches.length ? <div className="import-table-wrap"><table className="import-table">
      <thead><tr><th>Партия</th><th>Годен до</th><th>Свободный остаток</th><th>Себестоимость</th>{shown.map(type => <th key={type.code}>{type.name}</th>)}</tr></thead>
      <tbody>{data.batches.map(batch => <tr key={batch.batch_id}>
        <td>{batch.batch_number}{oldRule(batch.cost_basis)}</td><td>{day(batch.expiry_date)}</td><td>{stock(batch.available)}</td>
        <td>{batch.unit_cost == null ? "не утверждена" : `${number(batch.unit_cost, 4)} ${batch.cost_currency ?? ""} за ${units[batch.cost_uom ?? "piece"] ?? batch.cost_uom}`}</td>
        {shown.map(type => <MarginCell key={type.code} margin={batch.margins[type.code]}/>)}
      </tr>)}</tbody>
    </table></div> : <p className="empty-state">Свободного остатка этого товара нет.</p>}
  </section>;
}

/** Customer card: the customer's margin by product and batch, its threshold with history. */
export function CustomerMargins({ customerId, data }: { customerId: string; data: CustomerMarginsData }) {
  const below = data.rows.filter(row => row.below);
  return <section className="panel admin-section">
    <div className="panel-heading"><div><p className="eyebrow">Только с правом на закупочные цены</p><h2>Маржа клиента по партиям</h2></div><span className="page-count">{below.length} ниже порога</span></div>
    <p className="form-help">Цена клиента (с его процентом по бренду или фиксированная) без НДС против себестоимости каждой партии на складе. Порог — нижняя граница маржи для этого клиента; без порога проверка не выполняется, 0 % — это тоже порог. Когда маржа партии ниже порога, сотрудники, меняющие прайс, получают уведомление «Проверьте цену». Цена сама не меняется.</p>
    <div className="operation-facts"><div><small>Порог маржи</small><strong>{data.threshold == null ? "Не задан" : `${number(data.threshold)} %`}</strong></div></div>
    {data.can_manage && <form action={setCustomerMarginThreshold} className="reference-form">
      <input type="hidden" name="customer_id" value={customerId}/>
      <label>Порог маржи, %<input name="threshold_pct" inputMode="decimal" placeholder="Пусто — снять порог"/></label>
      <label className="wide-field">Причина<input name="reason" required minLength={3} maxLength={1000}/></label>
      <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Сохранить порог</PendingSubmitButton>
    </form>}
    {data.rows.length ? <div className="import-table-wrap"><table className="import-table">
      <thead><tr><th>Товар</th><th>Партия</th><th>Свободный остаток</th><th>Цена клиента</th><th>Маржа</th><th>Наценка</th></tr></thead>
      <tbody>{data.rows.map(row => <tr key={row.batch_id} className={row.below ? "has-error" : ""}>
        <td>{row.sku}<br/><small>{row.product}</small></td>
        <td>{row.batch_number}<br/><small>до {day(row.expiry_date)}</small>{oldRule(row.cost_basis)}</td>
        <td>{stock(row.available)}</td>
        <td>{row.price == null ? "—" : `${number(row.price)} ${row.currency ?? ""}`}{row.price_source === "fixed" && <><br/><small>фиксированная</small></>}</td>
        <td>{row.margin_pct == null ? <small>{MARGIN_REASONS[row.reason ?? ""] ?? row.reason}</small> : <>{number(row.margin_pct)} %{row.below && <><br/><small>ниже порога</small></>}</>}</td>
        <td>{row.markup_pct == null ? "—" : `${number(row.markup_pct)} %`}</td>
      </tr>)}</tbody>
    </table></div> : <p className="empty-state">Свободного остатка товаров нет.</p>}
    {!!data.history.length && <><h3>История порога</h3><div className="operation-history-list">{data.history.map((entry, index) => <article className="operation-history-row" key={index}>
      <time>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.created_at))}</time>
      <div><strong>{entry.previous == null ? "не задан" : `${number(entry.previous)} %`} → {entry.threshold == null ? "снят" : `${number(entry.threshold)} %`}</strong><small>{entry.reason} · {entry.author ?? "—"}</small></div>
    </article>)}</div></>}
  </section>;
}
