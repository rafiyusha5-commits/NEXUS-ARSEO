import { randomUUID } from "node:crypto";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { OperationTabs } from "@/components/operation-tabs";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { confirmPriceListImport, saveBrand, setPriceListPrice, setVatRate } from "./actions";

type PriceType = { id: string; code: string; name: string; market: string; currency: string; vat_included: boolean; payment_terms: string | null; is_reference: boolean; from_sheet: boolean };
type Price = { price: string; origin: "calculator" | "manual"; valid_from: string; reason: string | null };
type PriceRow = { id: string; sku: string; name: string; brand: string | null; brand_known: boolean; prices: Record<string, Price> };
type PriceList = { date: string; types: PriceType[]; products: PriceRow[] };
type ImportRow = { price_type: string; price_type_name: string; product_id: string; sku: string; product: string; status: string; sheet_value: string | null; current_price: string | null; current_origin: string | null; last_import_price: string | null; source_row: number | null };
type ImportPreview = { ok: boolean; reason?: string; problems?: Array<{ price_type: string; expected_key: string; expected_position: number; expected_field: string; found: { position?: number; field_ru?: string; visibility?: string } | null }>; valid_from?: string; counts?: Record<string, number>; rows?: ImportRow[]; stamp?: string };
type History = Array<{ price_type: string; price: string; valid_from: string; origin: string; reason: string | null; created_at: string; author: string | null; source_row: string | null }>;
type Brands = { brands: Array<{ id: string; name: string; products: number }>; unmatched: Array<{ text: string; products: number }> };
type VatHistory = Array<{ country: string; rate: string; valid_from: string; reason: string; created_at: string; author: string | null }>;

const statusNames: Record<string, string> = {
  new: "Новая цена", changed: "Цена изменилась", conflict: "Нужно решение", kept_manual: "Остаётся ручная цена",
  missing: "В листе пусто, цена остаётся", invalid: "В листе не число", unchanged: "Без изменений",
};
const markets: Record<string, string> = { KZ: "Казахстан", RU: "Россия", KG: "Кыргызстан" };
const money = (value: string | null | undefined) => value == null ? "—" : Number(value).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const day = (value: string) => new Intl.DateTimeFormat("ru-RU").format(new Date(value));
const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

// Sales price list: prices by type, calculator import with explicit conflict decisions, manual corrections,
// brands and VAT. Calculated prices, margins and costs of the calculator never appear here.
export default async function PriceListPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; success?: string; product?: string; date?: string; import_from?: string }> }) {
  const notices = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["pricing.list.manage"] as const);
  const canManage = permissions["pricing.list.manage"];
  const onDate = notices.date && /^\d{4}-\d{2}-\d{2}$/.test(notices.date) ? notices.date : null;
  const importFrom = notices.import_from && /^\d{4}-\d{2}-\d{2}$/.test(notices.import_from) ? notices.import_from : null;
  const product = notices.product && /^[0-9a-f-]{36}$/i.test(notices.product) ? notices.product : null;

  const [{ data: list, error }, { data: brands }, { data: vat }, preview, history] = await Promise.all([
    supabase.rpc("price_list", { p_date: onDate }),
    supabase.rpc("brand_overview"),
    supabase.rpc("vat_rate_history"),
    canManage && notices.tab === "import" ? supabase.rpc("price_list_import_preview", { p_valid_from: importFrom }) : Promise.resolve({ data: null }),
    product ? supabase.rpc("price_list_history", { p_product_id: product }) : Promise.resolve({ data: null }),
  ]);
  const priceList = list as PriceList | null;
  const brandData = brands as Brands | null;
  const importPreview = preview.data as ImportPreview | null;
  const productHistory = history.data as History | null;
  const types = priceList?.types ?? [];
  const rows = priceList?.products ?? [];
  const selected = rows.find(row => row.id === product);
  const conflicts = (importPreview?.rows ?? []).filter(row => row.status === "conflict");

  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="price-list"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Продажи</p><h1>Прайс</h1></div></header>
    {notices.error && <div className="login-error admin-message">{notices.error}</div>}{notices.success && <div className="login-success admin-message">{notices.success}</div>}
    {error && <div className="setup-notice">Прайс недоступен: нужны права «Клиентские заказы: просмотр» и «Товары: просмотр» или миграция <strong>202611170100_sales_price_list.sql</strong>.</div>}
    {!error && <OperationTabs ariaLabel="Разделы прайса" activeTab={notices.tab} defaultTab="list" tabs={[
      { id: "list", label: "Цены", badge: rows.length },
      ...(canManage ? [{ id: "import", label: "Загрузка из калькулятора" }] : []),
      { id: "brands", label: "Бренды", badge: brandData?.unmatched.length ?? 0 },
      { id: "vat", label: "НДС" },
    ]}>
      <>
        <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">Цены за штуку на {priceList ? day(priceList.date) : "—"}</p><h2>Действующий прайс</h2></div>
            <form className="inline-action" action="/sales/prices"><input type="hidden" name="tab" value="list"/><label>На дату<input type="date" name="date" defaultValue={onDate ?? ""}/></label><button className="ghost" type="submit">Показать</button></form></div>
          <p className="form-help">Цены берутся из колонок «Установленные цены» калькулятора, только после загрузки с предпросмотром. Расчётные цены, маржа и себестоимость калькулятора сюда не попадают. Ручная цена отмечена значком ✎.</p>
          <div className="import-table-wrap"><table className="import-table">
            <thead><tr><th>Товар</th><th>Бренд</th>{types.map(type => <th key={type.id}>{type.name}<br/><small>{type.currency}, {type.vat_included ? "с НДС" : "без НДС"}{type.is_reference ? ", справочно" : ""}</small></th>)}</tr></thead>
            <tbody>{rows.map(row => <tr key={row.id}>
              <td><Link href={`/sales/prices?tab=list&product=${row.id}${onDate ? `&date=${onDate}` : ""}`}>{row.sku}</Link><br/><small>{row.name}</small></td>
              <td>{row.brand || "—"}{!row.brand_known && <><br/><small className="load-warning-text">нет в справочнике брендов</small></>}</td>
              {types.map(type => { const price = row.prices[type.code]; return <td key={type.id}>{price ? <>{money(price.price)}{price.origin === "manual" && <span title={price.reason ?? "Ручная корректировка"}> ✎</span>}<br/><small>с {day(price.valid_from)}</small></> : "—"}</td>; })}
            </tr>)}</tbody>
          </table></div>
          {!rows.length && <p className="empty-state">Цен пока нет. Администратор загружает их из калькулятора на вкладке «Загрузка из калькулятора».</p>}
        </section>
        {selected && <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">{selected.sku}</p><h2>История цен: {selected.name}</h2></div><Link className="ghost button-link compact" href={`/sales/prices?tab=list${onDate ? `&date=${onDate}` : ""}`}>Закрыть</Link></div>
          {canManage && <form action={setPriceListPrice} className="reference-form">
            <input type="hidden" name="request_id" value={randomUUID()}/><input type="hidden" name="product_id" value={selected.id}/>
            <label>Вид цены<select name="price_type_id" required>{types.map(type => <option key={type.id} value={type.id}>{type.name} ({type.currency})</option>)}</select></label>
            <label>Цена за штуку<input name="price" inputMode="decimal" required/></label>
            <label>Действует с<input type="date" name="valid_from" required defaultValue={priceList?.date}/></label>
            <label className="wide-field">Причина корректировки<input name="reason" required minLength={3} maxLength={1000} placeholder="Например: согласовано с сетью"/></label>
            <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Изменить цену</PendingSubmitButton>
          </form>}
          <table className="import-table"><thead><tr><th>Вид цены</th><th>Цена</th><th>Действует с</th><th>Откуда</th><th>Причина</th><th>Кто и когда</th></tr></thead>
            <tbody>{(productHistory ?? []).map((entry, index) => <tr key={index}>
              <td>{entry.price_type}</td><td>{money(entry.price)}</td><td>{day(entry.valid_from)}</td>
              <td>{entry.origin === "manual" ? "Ручная корректировка" : `Калькулятор${entry.source_row ? `, строка ${entry.source_row}` : ""}`}</td>
              <td>{entry.reason ?? "—"}</td><td>{entry.author ?? "—"}<br/><small>{dateTime(entry.created_at)}</small></td>
            </tr>)}</tbody></table>
        </section>}
      </>
      {canManage && <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Только чтение из снимка калькулятора</p><h2>Загрузка цен из калькулятора</h2></div>
          <form className="inline-action" action="/sales/prices"><input type="hidden" name="tab" value="import"/><label>Цены действуют с<input type="date" name="import_from" defaultValue={importFrom ?? importPreview?.valid_from ?? ""}/></label><button className="ghost" type="submit">Обновить предпросмотр</button></form></div>
        <p className="form-help">Источник — последний снимок калькулятора, уже загруженный в Nexus. Google-таблица не меняется. Новые и изменившиеся цены добавляются с датой начала, прежние остаются в истории. Если цену поправили вручную, а в листе она снова изменилась, выберите, что оставить.</p>
        {importPreview && !importPreview.ok && <div className="login-error admin-message">
          <strong>Структура листа изменилась, загрузка остановлена.</strong>
          <ul>{(importPreview.problems ?? []).map(problem => <li key={problem.price_type}>«{problem.expected_field}» ожидалась в колонке {problem.expected_position}{problem.found ? `, сейчас: колонка ${problem.found.position ?? "?"} «${problem.found.field_ru ?? "?"}»${problem.found.visibility && problem.found.visibility !== "sales" ? `, видимость ${problem.found.visibility}` : ""}` : ", сейчас не найдена"}</li>)}</ul>
          <p>Проверьте лист и обновите загрузку калькулятора. Цены не менялись.</p>
        </div>}
        {importPreview?.ok && <form action={confirmPriceListImport}>
          <input type="hidden" name="request_id" value={randomUUID()}/><input type="hidden" name="stamp" value={importPreview.stamp}/><input type="hidden" name="valid_from" value={importPreview.valid_from}/>
          <div className="load-summary-grid">{Object.entries(importPreview.counts ?? {}).map(([status, count]) => <article className="summary-card" key={status}><p>{statusNames[status] ?? status}</p><strong>{count}</strong></article>)}</div>
          <div className="import-table-wrap"><table className="import-table">
            <thead><tr><th>Товар</th><th>Вид цены</th><th>Что произошло</th><th>В листе</th><th>Сейчас в Nexus</th><th>Решение</th></tr></thead>
            <tbody>{(importPreview.rows ?? []).map(row => { const key = `${row.price_type}:${row.product_id}`; return <tr key={key} className={row.status === "invalid" || row.status === "conflict" ? "has-error" : ""}>
              <td>{row.sku}<br/><small>{row.product}{row.source_row ? ` · строка ${row.source_row}` : ""}</small></td>
              <td>{row.price_type_name}</td><td>{statusNames[row.status] ?? row.status}</td>
              <td>{row.status === "invalid" ? "не число" : money(row.sheet_value)}</td>
              <td>{money(row.current_price)}{row.current_origin === "manual" && " (исправлено вручную)"}</td>
              <td>{row.status === "conflict"
                ? <><label className="check-label"><input type="radio" name={`decision:${key}`} value="keep_manual" required/> оставить ручную</label><label className="check-label"><input type="radio" name={`decision:${key}`} value="take_sheet"/> взять из листа</label></>
                : row.status === "new" || row.status === "changed" ? "будет загружена" : "не меняется"}</td>
            </tr>; })}</tbody>
          </table></div>
          {!(importPreview.rows ?? []).length && <p className="empty-state">Все цены совпадают с листом. Загружать нечего.</p>}
          <div className="import-confirm"><PendingSubmitButton pendingText="Загружаем…" className="primary" type="submit" disabled={!(importPreview.counts?.new || importPreview.counts?.changed || conflicts.length)}>Загрузить цены</PendingSubmitButton><span>{conflicts.length ? `Решений нужно: ${conflicts.length}` : "Конфликтов нет"}</span></div>
        </form>}
      </section>}
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Справочник</p><h2>Бренды</h2></div></div>
        <p className="form-help">Процент клиента задаётся по бренду из справочника. Бренд товара сравнивается с ним без учёта регистра и лишних пробелов. Карточки товаров не переписываются: расхождения показаны ниже, исправляются в карточке товара или добавлением бренда.</p>
        {canManage && <form action={saveBrand} className="inline-action"><label>Название бренда<input name="name" required maxLength={120}/></label><PendingSubmitButton pendingText="Добавляем…" className="secondary" type="submit">Добавить бренд</PendingSubmitButton></form>}
        <div className="reference-list">{(brandData?.brands ?? []).map(brand => <article className="reference-row" key={brand.id}><div><strong>{brand.name}</strong></div><span className="reference-meta">товаров: {brand.products}</span></article>)}</div>
        {!!brandData?.unmatched.length && <><h3>Не найдены в справочнике</h3><div className="reference-list">{brandData.unmatched.map(item => <article className="reference-row" key={item.text}><div><strong>{item.text || "Бренд не указан"}</strong><small>Цена клиенту по проценту для этих товаров не рассчитывается</small></div><span className="reference-meta">товаров: {item.products}</span>{canManage && item.text && <form action={saveBrand}><input type="hidden" name="name" value={item.text}/><PendingSubmitButton pendingText="…" className="ghost compact" type="submit">Добавить</PendingSubmitButton></form>}</article>)}</div></>}
      </section>
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Настройка</p><h2>Ставки НДС</h2></div></div>
        <p className="form-help">Ставка хранится с датой начала действия и используется в расчётах выручки без НДС. Значение вводит администратор по действующему законодательству; Nexus его не подставляет.</p>
        {canManage && <form action={setVatRate} className="reference-form">
          <label>Страна<select name="country" defaultValue="KZ">{Object.entries(markets).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
          <label>Ставка, %<input name="rate_percent" inputMode="decimal" required/></label>
          <label>Действует с<input type="date" name="valid_from" required/></label>
          <label className="wide-field">Основание<input name="reason" required minLength={3} maxLength={1000} placeholder="Например: Налоговый кодекс РК"/></label>
          <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Сохранить ставку</PendingSubmitButton>
        </form>}
        <table className="import-table"><thead><tr><th>Страна</th><th>Ставка</th><th>Действует с</th><th>Основание</th><th>Кто и когда</th></tr></thead>
          <tbody>{((vat as VatHistory | null) ?? []).map((row, index) => <tr key={index}><td>{markets[row.country] ?? row.country}</td><td>{(Number(row.rate) * 100).toLocaleString("ru-RU")} %</td><td>{day(row.valid_from)}</td><td>{row.reason}</td><td>{row.author ?? "—"}<br/><small>{dateTime(row.created_at)}</small></td></tr>)}</tbody></table>
        {!(vat as VatHistory | null)?.length && <p className="empty-state">Ставка НДС ещё не задана.</p>}
      </section>
    </OperationTabs>}
  </section></main>;
}
