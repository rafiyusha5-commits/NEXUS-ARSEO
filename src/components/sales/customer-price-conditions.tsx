import { PendingSubmitButton } from "@/components/pending-submit-button";
import { setCustomerBrandMarkup, setCustomerFixedPrice, setCustomerPriceTerms } from "@/app/sales/prices/actions";

type Entry = { valid_from: string; reason: string; created_at: string; author: string | null };
export type CustomerPriceConditionsData = {
  can_manage: boolean;
  price_types: Array<{ id: string; name: string; currency: string; vat_included: boolean }>;
  brands: Array<{ id: string; name: string }>;
  terms: Array<Entry & { price_type: string; currency: string }>;
  markups: Array<Entry & { brand: string; percent: string | null }>;
  fixed: Array<Entry & { product: string; sku: string; price: string | null; currency: string }>;
};

const day = (value: string) => new Intl.DateTimeFormat("ru-RU").format(new Date(value));
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Almaty" });

/** Latest entry per key on today's date: what applies now. Entries are sorted newest first by the database. */
function current<T extends Entry>(rows: T[], key: (row: T) => string) {
  const now = today();
  const seen = new Map<string, T>();
  for (const row of rows) if (row.valid_from <= now && !seen.has(key(row))) seen.set(key(row), row);
  return [...seen.values()];
}

function Author({ row }: { row: Entry }) {
  return <small>{row.reason} · {row.author ?? "—"}, {day(row.created_at)}</small>;
}

/** Customer card: price type, contract currency, percent per brand and fixed prices, all dated with history. */
export function CustomerPriceConditions({ customerId, data, currencies }: { customerId: string; data: CustomerPriceConditionsData; currencies: Array<{ id: string; code: string }> }) {
  const terms = current(data.terms, () => "terms")[0];
  const markups = current(data.markups, row => row.brand).filter(row => row.percent != null);
  const fixed = current(data.fixed, row => row.sku).filter(row => row.price != null);
  return <>
    <section className="panel admin-section">
      <div className="panel-heading"><div><p className="eyebrow">Цены клиента</p><h2>Действующие условия</h2></div></div>
      <p className="form-help">Цена клиенту = цена прайса его вида × (1 + процент по бренду), в валюте контракта по официальному курсу на дату заказа. Фиксированная цена товара важнее процента. Если по бренду нет условия, берётся цена прайса без процента. Все изменения действуют с даты и остаются в истории.</p>
      <div className="operation-facts">
        <div><small>Вид цены</small><strong>{terms ? terms.price_type : "Не задан"}</strong>{terms && <small>с {day(terms.valid_from)}</small>}</div>
        <div><small>Валюта контракта</small><strong>{terms?.currency ?? "—"}</strong></div>
        <div><small>Процентов по брендам</small><strong>{markups.length}</strong></div>
        <div><small>Фиксированных цен</small><strong>{fixed.length}</strong></div>
      </div>
      <div className="tag-list">{markups.map(row => <span className="reference-tag" key={row.brand}>{row.brand}: {Number(row.percent) > 0 ? "+" : ""}{Number(row.percent).toLocaleString("ru-RU")} %</span>)}</div>
      <div className="reference-list">{fixed.map(row => <article className="reference-row" key={row.sku}><div><strong>{row.sku} · {row.product}</strong><small>с {day(row.valid_from)}</small></div><span className="reference-meta">{Number(row.price).toLocaleString("ru-RU")} {row.currency} за шт.</span></article>)}</div>
    </section>
    {data.can_manage && <section className="panel admin-section">
      <div className="panel-heading"><div><p className="eyebrow">Изменение условий</p><h2>Новые условия с даты</h2></div></div>
      <form action={setCustomerPriceTerms} className="reference-form">
        <input type="hidden" name="customer_id" value={customerId}/>
        <label>Вид цены<select name="price_type_id" required>{data.price_types.map(type => <option key={type.id} value={type.id}>{type.name} ({type.currency}, {type.vat_included ? "с НДС" : "без НДС"})</option>)}</select></label>
        <label>Валюта контракта<select name="currency_id" required>{currencies.map(currency => <option key={currency.id} value={currency.id}>{currency.code}</option>)}</select></label>
        <label>Действует с<input type="date" name="valid_from" required defaultValue={today()}/></label>
        <label className="wide-field">Причина<input name="reason" required minLength={3} maxLength={1000} placeholder="Например: договор поставки №…"/></label>
        <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Сохранить вид цены</PendingSubmitButton>
      </form>
      <form action={setCustomerBrandMarkup} className="reference-form">
        <input type="hidden" name="customer_id" value={customerId}/>
        <label>Бренд<select name="brand_id" required>{data.brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label>
        <label>Процент к прайсу<input name="percent" inputMode="decimal" placeholder="10 или -5; пусто — снять условие"/></label>
        <label>Действует с<input type="date" name="valid_from" required defaultValue={today()}/></label>
        <label className="wide-field">Причина<input name="reason" required minLength={3} maxLength={1000}/></label>
        <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Сохранить процент</PendingSubmitButton>
      </form>
      <form action={setCustomerFixedPrice} className="reference-form">
        <input type="hidden" name="customer_id" value={customerId}/>
        <label>Артикул товара<input name="sku" required/></label>
        <label>Цена за штуку<input name="price" inputMode="decimal" placeholder="пусто — снять цену"/></label>
        <label>Валюта<select name="currency_id" required>{currencies.map(currency => <option key={currency.id} value={currency.id}>{currency.code}</option>)}</select></label>
        <label>Действует с<input type="date" name="valid_from" required defaultValue={today()}/></label>
        <label className="wide-field">Причина<input name="reason" required minLength={3} maxLength={1000}/></label>
        <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Сохранить фиксированную цену</PendingSubmitButton>
      </form>
      <p className="form-help">Фиксированная цена задаётся в валюте контракта. Если валюта другая, Nexus цену не подставит и покажет причину.</p>
    </section>}
    <section className="panel admin-section">
      <div className="panel-heading"><div><p className="eyebrow">Хронология</p><h2>История условий</h2></div></div>
      <div className="operation-history-list">
        {data.terms.map((row, index) => <article className="operation-history-row" key={`t${index}`}><time>с {day(row.valid_from)}</time><div><strong>Вид цены: {row.price_type}, валюта {row.currency}</strong><Author row={row}/></div></article>)}
        {data.markups.map((row, index) => <article className="operation-history-row" key={`m${index}`}><time>с {day(row.valid_from)}</time><div><strong>{row.brand}: {row.percent == null ? "условие снято" : `${Number(row.percent).toLocaleString("ru-RU")} %`}</strong><Author row={row}/></div></article>)}
        {data.fixed.map((row, index) => <article className="operation-history-row" key={`f${index}`}><time>с {day(row.valid_from)}</time><div><strong>{row.sku}: {row.price == null ? "фиксированная цена снята" : `${Number(row.price).toLocaleString("ru-RU")} ${row.currency}`}</strong><Author row={row}/></div></article>)}
        {!data.terms.length && !data.markups.length && !data.fixed.length && <p className="empty-state">Условия цен для клиента ещё не заданы.</p>}
      </div>
    </section>
  </>;
}
