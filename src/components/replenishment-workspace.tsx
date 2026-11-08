import Link from "next/link";
import { calculate, type Settings } from "@/lib/replenishment/calculate";
import { cityName, type Workspace } from "@/lib/replenishment/workspace";
import { ReplenishmentShare } from "./replenishment-share";
type Action = (form: FormData) => void | Promise<void>;
export type ReplenishmentActions = { createProfile: Action; setPurpose: Action; capture: Action; prepareDraft: Action };
const n = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
export function ReplenishmentWorkspace({ workspace: w, runId, requestId, actions, message }: { workspace: Workspace; runId: string | null; requestId: string; actions: ReplenishmentActions; message?: string }) {
  const p = w.profile;
  const defaults: Settings = p?.settings ?? { aktobe: "", astana: "", almaty: "", productionDays: 14, transitDays: 30, cityDays: 3, reviewDays: 7, transferDays: 3, historyDays: 90, serviceZ: 1.65, historyConfirmed: false, overrides: [] };
  let error = "", result: ReturnType<typeof calculate> | null = null;
  try { if (w.snapshot) result = calculate(w.snapshot); } catch { error = "Исходные данные неполны или противоречат друг другу. Проверьте упаковку и настройки."; }
  const blocked = !result || result.lines.some(l => l.blockers.length > 0) || result.warnings.length > 0;
  return <>
    <header className="topbar"><div><p className="eyebrow">Планирование закупки</p><h1>Автозаказ Казахстан</h1><p>Астана и Алматы отдельно. Экспорт не входит в прогноз. Все рекомендации требуют решения сотрудника.</p></div></header>
    {message && <p className="setup-notice" role="status">{message}</p>}
    <section className="admin-panel">
      <h2>Выберите настройки поставщика</h2>
      <form method="get" className="replenishment-actions"><label>Сохранённые настройки<select name="profile" defaultValue={p?.id ?? ""} required><option value="">Выберите</option>{w.profiles.map(x => <option key={x.id} value={x.id}>{x.name} · {x.created_at.slice(0, 10)}</option>)}</select></label><button>Открыть</button></form>
      <details open={!p}><summary>{p ? "Новая версия настроек и стартовый спрос" : "Настроить первый расчёт"}</summary>
        <form action={actions.createProfile} className="replenishment-form">
          {p && <input type="hidden" name="profile" value={p.id}/>}
          <label>Название<input name="name" required minLength={2} maxLength={120} defaultValue={p?.name ?? "План Казахстан"}/></label>
          <label>Поставщик<select name="supplier" required defaultValue={p?.supplier_id ?? ""}><option value="">Выберите</option>{w.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          {(["aktobe", "astana", "almaty"] as const).map(city => <label key={city}>{city === "aktobe" ? "Основной склад Актобе" : cityName(city)}<select name={city} required defaultValue={defaults[city]}><option value="">Выберите склад</option>{w.warehouses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>)}
          {([["productionDays", "Подготовка у производителя, дней", 0, 180], ["transitDays", "Доставка и таможня до Актобе, дней", 0, 180], ["cityDays", "Доставка в город, дней", 0, 90], ["reviewDays", "Период пересмотра заказа, дней", 1, 90], ["transferDays", "Перемещение между складами, дней", 0, 90], ["historyDays", "История продаж, дней", 7, 365], ["serviceZ", "Коэффициент страхового запаса (1,65 ≈ 95%)", 0, 3]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" name={key} min={min} max={max} step={key === "serviceZ" ? ".01" : "1"} required defaultValue={defaults[key]}/></label>)}
          <label className="replenishment-wide"><input name="historyConfirmed" type="checkbox" defaultChecked={defaults.historyConfirmed}/> История продаж за выбранный период полная; дни отсутствия товара проверены</label>
          <p className="replenishment-wide muted">Коэффициент задаёт запас от колебаний спроса, а не общий процент для всех товаров. При неполной истории задайте спрос вручную. Возвраты и перемещения не становятся новыми продажами.</p>
          {w.snapshot?.products.map(product => <fieldset key={product.id} className="replenishment-wide"><legend>{product.sku} · {product.name}: ручной спрос, шт. в день</legend><input name="product_id" type="hidden" value={product.id}/><div className="replenishment-form">{(["astana", "almaty"] as const).map(city => {
            const override = defaults.overrides.find(o => o.productId === product.id && o.city === city);
            return <label key={city}>{cityName(city)}<input name={`${product.id}:${city}`} type="number" min="0" step=".001" defaultValue={override?.daily} placeholder="По истории"/><input aria-label={`Причина ${product.sku} ${cityName(city)}`} name={`${product.id}:${city}:reason`} defaultValue={override?.reason} placeholder="Причина ручного значения" maxLength={1000}/></label>;
          })}</div></fieldset>)}
          <label className="replenishment-wide">Основание настроек<textarea name="reason" required minLength={3} maxLength={1000} placeholder="Откуда взяты сроки и спрос"/></label>
          <button>Сохранить отдельную версию настроек</button>
        </form>
      </details>
    </section>
    {p && <>
      <section className="admin-panel" id="supply"><h2>Назначение товара</h2><p>Указывайте свободное количество в штуках. Остаток сверх разметки считается неизвестным. Изменение остатка требует повторной проверки назначения. Для новой версии настроек разметка подтверждается отдельно.</p>
        {w.sources.length === 0 && <p>Свободного остатка и подтверждённых ожидаемых приходов нет.</p>}
        {w.sources.map(source => {
          const saved = w.purposes.find(x => x.source_key === source.id && x.source_signature === source.signature);
          const product = w.snapshot?.products.find(x => x.id === source.productId);
          return <details key={source.id}><summary>{product?.sku} · {source.batch} · {source.kind === "stock" ? "Свободный остаток" : "Ожидается"} {n(source.quantity)} шт. · {w.warehouses.find(x => x.id === source.warehouseId)?.name ?? "Склад поставки"}</summary>
            <form action={actions.setPurpose} className="replenishment-form"><input name="profile" type="hidden" value={p.id}/><input name="source" type="hidden" value={source.id}/><input name="signature" type="hidden" value={source.signature}/>
              <label>Для Казахстана, шт.<input name="kz" type="number" min="0" max={source.quantity} step=".001" required defaultValue={saved?.kz_quantity ?? 0}/></label>
              <label>Под экспорт, шт.<input name="export" type="number" min="0" max={source.quantity} step=".001" required defaultValue={saved?.export_quantity ?? 0}/></label>
              <label>Город Казахстана<select name="city" defaultValue={saved?.city ?? ""}><option value="">Общий запас KZ (только остаток)</option><option value="astana">Астана</option><option value="almaty">Алматы</option></select></label>
              <label>Идентификатор экспортного заказа<input name="export_sale_id" defaultValue={saved?.export_sale_id ?? ""} placeholder="Из адреса карточки заказа"/></label>
              {source.kind === "inbound" && <><label>Подтверждённый срок годности<input name="expiry" type="date" defaultValue={saved?.expiry ?? ""}/></label><label>Дата производства (если известна)<input name="manufactured" type="date" defaultValue={saved?.manufactured ?? ""}/></label><label>Прибытие в город Казахстана<input name="arrival" type="date" defaultValue={saved?.arrival ?? source.availableOn}/></label></>}
              <label className="replenishment-wide">Основание назначения<textarea name="reason" required minLength={3} maxLength={1000} defaultValue={saved?.reason}/></label>
              <button>Сохранить назначение</button>
            </form>
          </details>;
        })}
      </section>
      <section className="admin-panel" id="result"><h2>{runId ? "Сохранённый расчёт" : "Предпросмотр на текущих данных"}</h2>
        <p>История: {w.snapshot?.historyStart} — {w.snapshot?.historyEnd}. Все количества в штуках. Спрос распределяется по дням, текущий неполный день исключён.</p>
        {runId && !w.fresh && <p className="setup-notice">Данные изменились или наступил новый рабочий день. Эта версия доступна как история; сохраните новый расчёт.</p>}
        <form action={actions.capture}><input name="profile" type="hidden" value={p.id}/><input name="request" type="hidden" value={requestId}/><button>Пересчитать и сохранить новую версию</button></form>
        {error && <p className="login-error">{error}</p>}
        {result && <>
          {result.warnings.map(w => <p key={w} className="setup-notice">{w}</p>)}
          <div className="replenishment-table"><table><caption>Потребность до {result.horizonEnd}; версия формулы {result.version}</caption><thead><tr>{["Товар / город", "Спрос", "Страховой запас", "Запас / приход в расчёте", "Закупить", "Переместить (предложение)", "После подтверждения перемещения"].map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>{result.lines.map(l => <tr key={`${l.productId}:${l.city}`}><th>{l.sku}<br/>{cityName(l.city)}</th><td>{n(l.demand)}</td><td>{n(l.safety)}</td><td>{n(l.usable)} / {n(l.inbound)}</td><td>{n(l.purchase)}</td><td>{n(l.proposedTransfer)}</td><td>{n(l.afterTransfers)}</td></tr>)}</tbody></table></div>
          {result.lines.filter(l => l.blockers.length || l.notes.length).map(l => <details key={`${l.productId}:${l.city}`} open={l.blockers.length > 0}><summary>{l.sku} · {cityName(l.city)} — основания и замечания</summary><ul>{[...l.blockers, ...l.notes].map((v, i) => <li key={i}>{v}</li>)}</ul><p>Экспорт исключён: {n(l.excludedExport)} шт.; назначение не уточнено: {n(l.unknown)} шт.</p></details>)}
          <h3>Перемещения между складами</h3>
          {result.transfers.length === 0 ? <p>Подходящего излишка для перемещения не найдено.</p> : <ul>{result.transfers.map((t, i) => <li key={i}>{w.snapshot?.products.find(p => p.id === t.productId)?.sku}: {w.warehouses.find(w => w.id === t.from)?.name} → {cityName(t.to)}, {n(t.quantity)} шт., прибытие {t.arrival}. <Link href="/inventory/movements">Перейти к складским документам</Link></li>)}</ul>}
          <h3>Риск остаточного срока годности</h3>
          {result.risks.length === 0 ? <p>По доступным данным на горизонте расчёта риска не выявлено. Это не подтверждает полноту исходных данных.</p> : <ul>{result.risks.map(r => <li key={r.supplyId}><strong>{r.level === "critical" ? "Срочно" : r.level === "unknown" ? "Уточнить" : "Предупреждение"}</strong>: {r.sku}, партия {r.batch}, {n(r.quantity)} шт., {r.deadline ?? "дата неизвестна"}. {r.message}</li>)}</ul>}
          {runId && <><p>Расчёт сохранён: {runId}. Настройки, история и решения остаются в Nexus.</p>
            <form action={actions.prepareDraft} className="replenishment-form"><input name="run" type="hidden" value={runId}/><input name="kind" type="hidden" value="forecast"/><label>Причина подготовки прогноза<textarea name="reason" required minLength={3} maxLength={1000}/></label><button disabled={blocked || !w.fresh}>Подготовить черновик прогноза</button></form>
            <p>Сначала проверьте и утвердите прогноз через штатное согласование, затем подготовьте план закупки. Остатки, поставки и резервы не меняются.</p>
            {w.decisions.filter(d => d.forecast_id).map(d => <p key={d.id}><Link href={`/forecasts?id=${d.forecast_id}`}>Открыть прогноз</Link>{d.purchase_plan_id && <> · <Link href={`/purchase-plans?id=${d.purchase_plan_id}`}>Открыть план закупки</Link></>}</p>)}
            <form action={actions.prepareDraft} className="replenishment-form"><input name="run" type="hidden" value={runId}/><input name="kind" type="hidden" value="purchase"/><label>Идентификатор утверждённого прогноза<input name="forecast_id" required defaultValue={w.decisions.find(d => d.kind === "forecast")?.forecast_id ?? ""}/></label><label>Причина подготовки плана<textarea name="reason" required minLength={3} maxLength={800}/></label>{result.transfers.length > 0 && <label className="replenishment-wide"><input name="use_existing_kz" type="checkbox" required/> Учитываю существующий запас KZ из последнего столбца; перемещения нужно оформить отдельно</label>}<button disabled={blocked || !w.fresh}>Подготовить черновик плана закупки</button></form>
          </>}
        </>}
      </section>
      {runId && result && <ReplenishmentShare run={runId} date={result.asOf} enabled={w.fresh && !blocked}/>}
      <section className="admin-panel"><h2>История расчётов и решений</h2><ul>{w.runs.map(r => <li key={r.id}><Link href={`/replenishment?run=${r.id}`}>{r.created_at} · {r.algorithm}</Link></li>)}</ul>{w.decisions.map(d => <p key={d.id}>{d.created_at} · {d.kind === "forecast" ? "Подготовлен прогноз" : "Подготовлен план"}: {d.reason}</p>)}</section>
    </>}
  </>;
}
