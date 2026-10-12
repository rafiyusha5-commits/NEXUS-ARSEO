import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import {
  CUSTOMER_STATE_LABEL, DEFAULT_REQUIRED_PCT, HORIZON_OPTIONS, RISK_STATE_LABEL, customerAdvice, describeRequirement,
  formatIsoDate, formatPct, formatQuantities, parseHorizon, parseShelfLifeRisks, summarizeRisks,
} from "@/lib/shelf-life/rules";

// Agent «Контроль ОСГ»: batches whose remaining shelf life falls below customer requirements. The list is
// calculated by the database for the signed-in employee; the agent itself changes nothing.
export default async function ShelfLifeRiskPage({ searchParams }: { searchParams: Promise<{ horizon?: string }> }) {
  const { profile, roles, supabase } = await requireUser();
  const horizon = parseHorizon((await searchParams).horizon);
  const permissions = await loadPermissions(supabase, ["inventory.view", "products.view", "sales.view"] as const);
  const allowed = permissions["inventory.view"] && permissions["products.view"];
  const { data, error } = allowed ? await supabase.rpc("shelf_life_risks", { p_horizon_days: horizon }) : { data: null, error: null };
  const risks = parseShelfLifeRisks(data);
  const summary = summarizeRisks(risks.items);

  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shelf-life"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Агент «Контроль ОСГ»</p><h1>Сроки годности под риском</h1></div><div className="topbar-actions"><Link className="secondary compact" href="/inventory">Остатки и партии</Link></div></header>
    {!allowed && <div className="empty-state">Нужны права «Остатки: просмотр» и «Товары: просмотр». Обратитесь к администратору.</div>}
    {allowed && error && <div className="setup-notice">Список недоступен. Если модуль ещё не подключён, примените миграцию <strong>202609276500_shelf_life_control_agent.sql</strong>.</div>}
    {allowed && !error && <>
      <section className="shipment-summary-grid">
        <article className="summary-card"><p>Под риском</p><strong>{summary.total}</strong><small>партий за {risks.horizonDays} дн.</small></article>
        <article className="summary-card"><p>Скоро ниже требований</p><strong>{summary.soon}</strong><small>ещё можно отгрузить</small></article>
        <article className="summary-card"><p>Уже ниже требований</p><strong>{summary.below}</strong><small>только с гарантийным письмом</small></article>
        <article className="summary-card"><p>Срок истёк</p><strong>{summary.expired}</strong><small>со свободным остатком</small></article>
      </section>
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Прогноз ОСГ</p><h2>Партии со свободным остатком</h2></div>
          <nav className="shelf-horizon" aria-label="Горизонт прогноза">{HORIZON_OPTIONS.map((days) => <Link key={days} className={days === horizon ? "active" : undefined} aria-current={days === horizon ? "page" : undefined} href={`/inventory/shelf-life?horizon=${days}`}>{days} дн.</Link>)}</nav>
        </div>
        <p className="form-help">Для каждой партии показано, до какого дня она проходит по требованию к остаточному сроку годности каждого клиента, который покупал этот товар за последний год. Требование берётся из договора (по товару, затем общее), затем из карточки клиента; если его нигде нет — {DEFAULT_REQUIRED_PCT} % по умолчанию. Клиенты внутри партии перечислены в порядке отгрузки: сначала те, у кого окно закрывается раньше. Список обновляется при каждом открытии; раз в день сотрудники со складским доступом получают сводку в уведомлениях Nexus.</p>
        {risks.unknownCount > 0 && <div className="setup-notice">Не посчитано партий: {risks.unknownCount} — нет даты производства партии и срока годности в карточке товара.</div>}
        {!risks.items.length && <div className="shelf-ok">В ближайшие {risks.horizonDays} дн. ни одна партия не опустится ниже требований клиентов.</div>}
        <ul className="shelf-risk-list">{risks.items.map((batch) => <li key={batch.batchId} className={`shelf-risk shelf-risk-${batch.state}`}>
          <div className="shelf-risk-head">
            <div><strong>{batch.productName}</strong><small>{batch.sku} · партия <Link href={`/inventory/${batch.batchId}`}>{batch.batchNumber}</Link> · склад {batch.warehouses ?? "—"}</small></div>
            <span className={`status shelf-risk-badge-${batch.state}`}>{RISK_STATE_LABEL[batch.state]}</span>
          </div>
          <dl className="shelf-risk-facts">
            <div><dt>Свободно</dt><dd>{formatQuantities(batch.quantities)}</dd></div>
            <div><dt>ОСГ сегодня</dt><dd>{formatPct(batch.remainingPct)}</dd></div>
            <div><dt>Годен до</dt><dd>{formatIsoDate(batch.expiryDate)}</dd></div>
            <div><dt>Произведено</dt><dd>{formatIsoDate(batch.manufactureDate)}</dd></div>
          </dl>
          <ol className="shelf-customers">{batch.customers.map((customer, index) => <li key={`${customer.customerId ?? "any"}-${index}`} className={`shelf-customer-${customer.state}`}>
            <div><strong>{describeRequirement(customer)}</strong><small>{customerAdvice(customer, batch.state === "expired")}</small></div>
            <span className="shelf-customer-state">{batch.state === "expired" ? "истёк" : CUSTOMER_STATE_LABEL[customer.state]}</span>
          </li>)}</ol>
          {batch.customers.some((customer) => customer.guaranteeLetter) && permissions["sales.view"] && <p className="form-help">Гарантийное письмо оформляется в заказе покупателя: <Link href="/sales">Заказы покупателей</Link>.</p>}
        </li>)}</ul>
      </section>
    </>}
  </section></main>;
}
