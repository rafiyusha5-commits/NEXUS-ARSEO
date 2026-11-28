import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requirePageUser } from "@/lib/auth/access";
import {
  incompleteText, lossGroupLabels, lossViewLabels, money, monthLabel, parseLossParams, percent, pieces, planLabels, riskGroupLabels,
  rowName, unitLabels, type LossGroup, type LossReport, type LossView, type RiskGroup, type RiskReport, type TrendReport,
  type UnclassifiedLine,
} from "@/lib/analytics/losses";
import { classifyLossReason } from "./actions";

const day = (value: string) => new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`));
type Params = { view?: string; group?: string; risk?: string; from?: string; to?: string; error?: string; success?: string };

// Losses of goods (write-offs, shortages, returned goods written off) and stock at risk by shelf life, in tenge.
// Quantities need reports.view and inventory.view; amounts also prices.purchase.view — the database leaves them empty.
export default async function LossesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { profile, roles, supabase, permissions } = await requirePageUser(["losses.reason_classify"]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  const { view, group, risk, from, to } = parseLossParams(params, today);
  const views = (Object.keys(lossViewLabels) as LossView[]).filter(key => key !== "unclassified" || permissions["losses.reason_classify"]);
  const query = (next: Partial<{ view: LossView; group: LossGroup; risk: RiskGroup; from: string; to: string }>) => {
    const values = { view, group, risk, from, to, ...next };
    return `?view=${values.view}&group=${values.group}&risk=${values.risk}&from=${values.from}&to=${values.to}`;
  };

  const [report, riskReport, trend, unclassified, reasons] = await Promise.all([
    view === "period" ? supabase.rpc("loss_report", { p_group: group, p_from: from, p_to: to }) : null,
    view === "risk" ? supabase.rpc("loss_risk", { p_group: risk }) : null,
    view === "trend" ? supabase.rpc("loss_trend", { p_months: 12 }) : null,
    view === "unclassified" && permissions["losses.reason_classify"] ? supabase.rpc("unclassified_loss_lines", { p_limit: 100 }) : null,
    view === "unclassified" ? supabase.from("inventory_loss_reasons").select("code,name").eq("is_active", true).order("sort_order") : null,
  ]);
  const denied = Boolean(report?.error || riskReport?.error || trend?.error || unclassified?.error);

  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="losses"/><section className="workspace admin-workspace">
    <header className="topbar">
      <div><p className="eyebrow">Аналитика</p><h1>Потери по срокам годности</h1></div>
      {!denied && <div className="topbar-actions">
        <a className="ghost button-link" href={`/analytics/losses/export?from=${from}&to=${to}`}>Скачать XLSX</a>
      </div>}
    </header>
    {params.error && <div className="login-error admin-message">{params.error}</div>}
    {params.success && <div className="login-success admin-message">{params.success}</div>}
    <nav className="operation-tab-list" aria-label="Вид отчёта">{views.map(key =>
      <Link key={key} className="operation-tab-button" aria-current={key === view ? "page" : undefined} href={query({ view: key })}>
        {lossViewLabels[key]}
      </Link>)}</nav>
    {denied && <div className="setup-notice">
      Отчёт о потерях доступен с правами «Отчёты: просмотр» и «Остатки: просмотр»; суммы — ещё с правом «Закупочные цены и себестоимость».
    </div>}
    {!denied && view === "period" && report?.data && <PeriodView report={report.data as LossReport} query={query} from={from} to={to}/>}
    {!denied && view === "risk" && riskReport?.data && <RiskView report={riskReport.data as RiskReport} query={query}/>}
    {!denied && view === "trend" && trend?.data && <TrendView report={trend.data as TrendReport}/>}
    {!denied && view === "unclassified" && unclassified?.data && <UnclassifiedView
      data={unclassified.data as { total: number; lines: UnclassifiedLine[] }}
      reasons={(reasons?.data ?? []) as { code: string; name: string }[]}/>}
  </section></main>;
}

type Query = (next: Partial<{ view: LossView; group: LossGroup; risk: RiskGroup; from: string; to: string }>) => string;

function PeriodView({ report, query, from, to }: { report: LossReport; query: Query; from: string; to: string }) {
  const totals = report.totals;
  return <>
    <form className="inline-action" action="/analytics/losses">
      <input type="hidden" name="view" value="period"/><input type="hidden" name="group" value={report.group}/>
      <label>С<input type="date" name="from" defaultValue={from}/></label><label>По<input type="date" name="to" defaultValue={to}/></label>
      <button className="ghost" type="submit">Показать</button>
    </form>
    <nav className="operation-tab-list" aria-label="Разрез отчёта">{(Object.keys(lossGroupLabels) as LossGroup[]).map(key =>
      <Link key={key} className="operation-tab-button" aria-current={key === report.group ? "page" : undefined} href={query({ group: key })}>
        {lossGroupLabels[key]}
      </Link>)}</nav>
    <section className="shipment-summary-grid">
      <article className="summary-card"><p>Потери, KZT</p><strong>{report.amounts ? money(totals.cost_kzt) : "—"}</strong>
        <small>{pieces(totals.pieces)} шт. · строк {totals.lines}
          {totals.incomplete_lines ? `, без полных данных ${totals.incomplete_lines}` : ""}</small></article>
      <article className="summary-card"><p>Доля от себестоимости продаж</p><strong>{report.amounts ? percent(totals.share_pct) : "—"}</strong>
        <small>себестоимость проданного {report.amounts ? money(totals.cost_of_sales_kzt) : "—"}</small></article>
      <article className="summary-card"><p>Причина не указана</p><strong>{totals.unspecified_lines}</strong>
        <small>{report.amounts ? `на ${money(totals.unspecified_cost_kzt)} KZT` : "строк"}</small></article>
      <article className="summary-card"><p>Справочно: возвраты по сроку и уценка</p>
        <strong>{report.amounts ? money(totals.returns_kzt) : pieces(totals.returns_pieces)}</strong>
        <small>{report.amounts ? `уценка ${money(totals.markdown_kzt)} KZT` : "шт. возвращено"} · в итог не входят</small></article>
    </section>
    {!report.amounts && <p className="form-help">Суммы скрыты: нет права «Закупочные цены и себестоимость». Показаны количества.</p>}
    <section className="panel admin-section">
      <div className="panel-heading">
        <div><p className="eyebrow">{day(report.from)} — {day(report.to)}, в тенге</p><h2>{lossGroupLabels[report.group]}</h2></div>
        <span className="page-count">{report.rows.length}</span></div>
      <p className="form-help">
        Потери — товар, которого больше нет: проведённые списания и уменьшения остатка, списанные возвраты клиентов и прямые списания
        до появления документов. Оценка — количество конкретной партии × её утверждённая себестоимость, в тенге по официальному курсу на
        дату потери. Без себестоимости, упаковки или курса строка видна с отметкой и в сумму как ноль не входит. Возвраты по сроку
        (возвращённая выручка) и уценка распродаж низкого срока (недополученная выручка) показаны справочно и в итог не складываются.
      </p>
      <div className="import-table-wrap"><table className="import-table">
        <thead><tr><th>{lossGroupLabels[report.group].replace("По ", "")}</th><th>Штук</th><th>Потери, KZT</th><th>Строк</th>
          <th>Возвраты по сроку</th><th>Уценка</th></tr></thead>
        <tbody>{report.rows.map(row => <tr key={row.key ?? "none"} className={incompleteText(row.statuses) ? "has-error" : ""}>
          <td>{rowName(report.group, row)}{incompleteText(row.statuses) && <><br/><small>{incompleteText(row.statuses)}</small></>}</td>
          <td>{pieces(row.pieces)}</td><td><strong>{report.amounts ? money(row.cost_kzt) : "—"}</strong></td><td>{row.lines}</td>
          <td>{Number(row.returns_pieces) ? `${pieces(row.returns_pieces)} шт.${report.amounts ? ` · ${money(row.returns_kzt)}` : ""}` : "—"}</td>
          <td>{report.amounts && Number(row.markdown_kzt) ? money(row.markdown_kzt) : "—"}
            {row.markdown_incomplete ? <><br/><small>без цены прайса: {row.markdown_incomplete}</small></> : null}</td>
        </tr>)}</tbody>
      </table></div>
      {!report.rows.length && <p className="empty-state">За период потерь нет.</p>}
    </section>
  </>;
}

function RiskView({ report, query }: { report: RiskReport; query: Query }) {
  const bucket = (key: string) => report.buckets?.[key];
  return <>
    <nav className="operation-tab-list" aria-label="Разрез товара под риском">{(Object.keys(riskGroupLabels) as RiskGroup[]).map(key =>
      <Link key={key} className="operation-tab-button" aria-current={key === report.group ? "page" : undefined} href={query({ risk: key })}>
        {riskGroupLabels[key]}
      </Link>)}</nav>
    <section className="shipment-summary-grid">
      {[["expired", "Срок истёк"], ["critical", "До 30 дней"], ["warning", "31–90 дней"]].map(([key, label]) =>
        <article className="summary-card" key={key}><p>{label}</p>
          <strong>{report.amounts ? money(bucket(key)?.cost_kzt) : pieces(bucket(key)?.pieces)}</strong>
          <small>{report.amounts ? `${pieces(bucket(key)?.pieces)} шт.` : "шт."} · остатков {bucket(key)?.balances ?? 0}</small></article>)}
    </section>
    <section className="panel admin-section">
      <div className="panel-heading"><div><p className="eyebrow">На {day(report.date)}, себестоимость в тенге</p><h2>{riskGroupLabels[report.group]}</h2></div>
        <span className="page-count">{report.rows.length}</span></div>
      <p className="form-help">Остатки, срок годности которых истёк или истекает в ближайшие 90 дней, по утверждённой себестоимости партии
        и официальному курсу на сегодня. «Нет плана продажи» — остаток не в резерве и не в распродаже низкого срока.</p>
      <div className="import-table-wrap"><table className="import-table">
        <thead><tr><th>Группа</th><th>Остатков</th><th>Штук</th><th>Себестоимость, KZT</th><th>Без плана продажи</th><th>Ближайший срок</th></tr></thead>
        <tbody>{report.rows.map(row => <tr key={row.key ?? "none"} className={row.incomplete ? "has-error" : ""}>
          <td>{row.name ?? "—"}{row.incomplete ? <><br/><small>без полных данных: {row.incomplete}</small></> : null}</td>
          <td>{row.balances}</td><td>{pieces(row.pieces)}</td><td>{report.amounts ? money(row.cost_kzt) : "—"}</td>
          <td>{pieces(row.no_plan_pieces)} шт.{report.amounts ? ` · ${money(row.no_plan_cost_kzt)}` : ""}</td>
          <td>{row.min_days_left < 0 ? "истёк" : `${row.min_days_left} дн.`}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <section className="panel admin-section">
      <div className="panel-heading"><div><p className="eyebrow">Партии</p><h2>Что под риском</h2></div>
        <span className="page-count">{report.items_total}</span></div>
      <div className="import-table-wrap"><table className="import-table">
        <thead><tr><th>Товар</th><th>Партия и срок</th><th>Склад</th><th>Остаток</th><th>План</th><th>Себестоимость, KZT</th></tr></thead>
        <tbody>{report.items.map(item => <tr key={item.balance_id} className={item.plan === "none" ? "has-error" : ""}>
          <td>{item.sku} · {item.product}<br/><small>{item.brand}</small></td>
          <td><Link href={`/inventory/${item.batch_id}`}>{item.batch}</Link><br/>
            <small>{day(item.expiry_date)} · {item.days_left < 0 ? "срок истёк" : `осталось ${item.days_left} дн.`}</small></td>
          <td>{item.warehouse ?? "—"}{item.location ? ` · ${item.location}` : ""}</td>
          <td>{pieces(item.quantity)} {unitLabels[item.uom] ?? item.uom}
            {Number(item.reserved) ? <><br/><small>в резерве {pieces(item.reserved)}</small></> : null}</td>
          <td>{planLabels[item.plan] ?? item.plan}</td><td>{report.amounts ? money(item.cost_kzt) : "—"}</td>
        </tr>)}</tbody>
      </table></div>
      {report.items_total > report.items.length && <p className="form-help">Показаны первые {report.items.length}; все строки — в выгрузке XLSX.</p>}
      {!report.items.length && <p className="empty-state">Товара под риском нет.</p>}
    </section>
  </>;
}

function TrendView({ report }: { report: TrendReport }) {
  const reasons = [...report.reasons, { code: "unspecified", name: "Причина не указана" }];
  return <section className="panel admin-section">
    <div className="panel-heading"><div><p className="eyebrow">{day(report.from)} — {day(report.to)}</p><h2>Потери по месяцам</h2></div>
      <span className="page-count">{report.months.length}</span></div>
    <p className="form-help">{report.amounts ? "Себестоимость в тенге и доля от себестоимости проданного за месяц." : "Количество в штуках: суммы скрыты."}</p>
    <div className="import-table-wrap"><table className="import-table">
      <thead><tr><th>Месяц</th><th>{report.amounts ? "Потери, KZT" : "Штук"}</th><th>Доля</th>
        {reasons.map(reason => <th key={reason.code}>{reason.name}</th>)}</tr></thead>
      <tbody>{report.months.map(month => <tr key={month.month} className={month.incomplete_lines ? "has-error" : ""}>
        <td>{monthLabel(month.month)}{month.incomplete_lines ? <><br/><small>без полных данных: {month.incomplete_lines}</small></> : null}</td>
        <td><strong>{report.amounts ? money(month.cost_kzt) : pieces(month.pieces)}</strong></td>
        <td>{report.amounts ? percent(month.share_pct) : "—"}</td>
        {reasons.map(reason => <td key={reason.code}>
          {month.by_reason[reason.code] ? (report.amounts ? money(month.by_reason[reason.code]) : pieces(month.by_reason[reason.code])) : "—"}
        </td>)}
      </tr>)}</tbody>
    </table></div>
  </section>;
}

function UnclassifiedView({ data, reasons }: { data: { total: number; lines: UnclassifiedLine[] }; reasons: { code: string; name: string }[] }) {
  return <section className="panel admin-section">
    <div className="panel-heading"><div><p className="eyebrow">Списания, проведённые без причины</p><h2>Указать причину</h2></div>
      <span className="page-count">{data.total}</span></div>
    <p className="form-help">Причину проведённого списания можно указать один раз, с основанием (акт, пояснение кладовщика). Кто, когда и
      почему — записывается в журнал аудита. Изменить указанную причину нельзя.</p>
    <div className="reference-list">{data.lines.map(line => <article className="reference-row" key={line.line_id}>
      <div><strong><Link href={`/inventory/movements/${line.document_id}?tab=items`}>{line.document_number}</Link> · {line.sku} · {line.product}</strong>
        <small>{day(line.document_date)} · партия {line.batch} · {pieces(line.quantity)} {unitLabels[line.uom] ?? line.uom}
          {line.warehouse ? ` · ${line.warehouse}` : ""} · в документе: «{line.document_reason || line.notes || "без текста"}»</small></div>
      <form action={classifyLossReason} className="inline-action">
        <input type="hidden" name="line_id" value={line.line_id}/>
        <select name="loss_reason_code" required defaultValue="" aria-label="Причина"><option value="" disabled>Причина</option>
          {reasons.map(reason => <option key={reason.code} value={reason.code}>{reason.name}</option>)}</select>
        <input name="basis" required minLength={10} maxLength={1000} placeholder="Основание" aria-label="Основание"/>
        <PendingSubmitButton pendingText="Сохраняем…" className="ghost">Сохранить</PendingSubmitButton>
      </form>
    </article>)}</div>
    {!data.lines.length && <p className="empty-state">Все проведённые списания с причиной.</p>}
  </section>;
}
