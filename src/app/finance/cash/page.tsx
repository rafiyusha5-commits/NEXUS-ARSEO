import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requirePageUser } from "@/lib/auth/access";
import {
  cashDay, cashItemHref, cashItemNote, cashKindLabel, cellHref, dayAfter, gapText, money, parseCashParams, periodLabel, staleBalanceText,
  type CashAccount, type CashCalendar, type CashCell, type CashCurrency, type CashPlanFact,
} from "@/lib/finance/cash-calendar";
import { recordCashBalance, saveCashAccount, setCashAccountActive, setCashGapAlertDays } from "./actions";

type Search = Record<string, string | string[] | undefined>;
const bucketTitle = { period: "Период", overdue: "Просрочено", no_date: "Срок оплаты не задан", later: "После горизонта" } as const;

// Money in and out by week (or day) and currency: the balance entered by hand, customer debts by due date, the rest of
// confirmed expenses by planned or due date, plan lines apart. finance.view; the database hides what the rights do not allow.
export default async function CashCalendarPage({ searchParams }: { searchParams: Promise<Search> }) {
  const raw = await searchParams;
  const params = parseCashParams(raw);
  const notice = { error: typeof raw.error === "string" ? raw.error : null, success: typeof raw.success === "string" ? raw.success : null };
  const { profile, roles, supabase } = await requirePageUser();
  const { data, error } = await supabase.rpc("cash_calendar", { p_step: params.step, p_periods: params.periods });
  const calendar = data as CashCalendar | null;
  const tabs = [
    { key: "calendar", label: "Календарь", href: `/finance/cash?step=${params.step}` },
    { key: "plan-fact", label: "План-факт", href: `/finance/cash?view=plan-fact&step=${params.step}` },
  ];
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="cash"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Финансы</p><h1>Платёжный календарь</h1></div>
      {!error && <div className="topbar-actions"><a className="ghost button-link" href={`/finance/cash/export?step=${params.step}`}>Скачать XLSX</a></div>}</header>
    {notice.error && <div className="login-error admin-message">{notice.error}</div>}{notice.success && <div className="login-success admin-message">{notice.success}</div>}
    {error && <div className="setup-notice">Платёжный календарь доступен с правом «Финансы: просмотр» после миграции <strong>202611280200_cash_calendar.sql</strong>.</div>}
    {!error && calendar && <>
      <nav className="operation-tab-list" aria-label="Раздел календаря">{tabs.map(tab =>
        <Link key={tab.key} className="operation-tab-button" aria-current={tab.key === params.view || (params.view === "items" && tab.key === "calendar") ? "page" : undefined} href={tab.href}>{tab.label}</Link>)}</nav>
      {!calendar.receivables && <div className="setup-notice">Без права «Дебиторка: просмотр» поступления от клиентов и по заказам не показаны: календарь видит только выплаты.</div>}
      {!calendar.goods && <div className="setup-notice">Без права на закупочные цены оплаты за товар не показаны: остаток может быть завышен.</div>}
      {params.view === "items" ? <Items supabase={supabase} params={params} calendar={calendar}/> : params.view === "plan-fact" ? <PlanFact supabase={supabase}/> : <>
        <nav className="operation-tab-list" aria-label="Шаг календаря">
          <Link className="operation-tab-button" aria-current={params.step === "week" ? "page" : undefined} href="/finance/cash?step=week">13 недель</Link>
          <Link className="operation-tab-button" aria-current={params.step === "day" ? "page" : undefined} href="/finance/cash?step=day">14 дней</Link>
        </nav>
        <section className="shipment-summary-grid">
          {calendar.currencies.map(currency => <article className="summary-card" key={currency.currency}>
            <p>Остаток на счетах, {currency.currency}</p><strong>{currency.opening.amount == null ? "не введён" : money(currency.opening.amount)}</strong>
            <small className={currency.first_gap || currency.opening.amount == null ? "load-warning-text" : undefined}>{gapText(currency)}</small>
          </article>)}
          {!calendar.currencies.length && <article className="summary-card"><p>Платёжный календарь</p><strong>пусто</strong><small>нет счетов, долгов и расходов к оплате</small></article>}
        </section>
        {calendar.currencies.map(currency => <CurrencyBlock key={currency.currency} calendar={calendar} currency={currency}/>)}
        <p className="form-help">Поступления — открытые долги клиентов по срокам оплаты (оплаты и возвраты закрывают самые старые долги первыми, как в дебиторке). Выплаты — остаток подтверждённых расходов на плановую дату оплаты, иначе на срок. Строки «план» — ожидаемое по неотгруженным заказам (дата отгрузки + отсрочка клиента) и плановые расходы, пока по ним нет фактического расхода того же вида; в «Остаток» они не входят, только в «Остаток с планом». Просроченное и расходы без срока не размазываются по неделям и показаны отдельно. Авансы без зачёта и переплаты — справочно: эти деньги уже ушли или вернутся без даты. Валюты не складываются; тенге — оценка по официальному курсу на сегодня.</p>
        <Accounts supabase={supabase} calendar={calendar}/>
      </>}
    </>}
  </section></main>;
}

function CurrencyBlock({ calendar, currency }: { calendar: CashCalendar; currency: CashCurrency }) {
  const stale = staleBalanceText(currency.opening, calendar.today);
  const cell = (value: string, from: string, to: string) => Number(value)
    ? <Link href={cellHref({ step: calendar.step, currency: currency.currency_id, bucket: "period", from, to })}>{money(value)}</Link> : "—";
  const outside = (value: string, bucket: "overdue" | "no_date" | "later") => Number(value)
    ? <Link href={cellHref({ step: calendar.step, currency: currency.currency_id, bucket, from: bucket === "later" ? dayAfter(calendar.to) : undefined })}>{money(value)}</Link> : "—";
  return <section className="panel admin-section">
    <div className="panel-heading"><div><p className="eyebrow">{calendar.step === "week" ? "По неделям" : "По дням"} · {cashDay(calendar.from)} — {cashDay(calendar.to)}</p><h2>{currency.currency}</h2></div>
      <span className={`page-count${currency.first_gap ? " receivable-overdue" : ""}`}>{currency.first_gap ? "кассовый разрыв" : currency.opening.amount == null ? "нет остатка" : "без разрыва"}</span></div>
    <p className={currency.first_gap ? "load-warning-text" : "form-help"}>{gapText(currency)}.</p>
    <p className="form-help">Остаток на начало: {currency.opening.amount == null ? "не введён" : `${money(currency.opening.amount, currency.currency)} на ${cashDay(currency.opening.as_of)}`}
      {currency.opening.accounts_without_balance ? ` · счетов без остатка: ${currency.opening.accounts_without_balance}` : ""}
      {currency.rate_kzt && currency.currency !== "KZT" ? ` · курс ${money(currency.rate_kzt)} KZT` : ""}
      {currency.rate_kzt == null && currency.currency !== "KZT" ? " · нет официального курса за 7 дней: оценки в тенге нет" : ""}</p>
    {stale && <p className="load-warning-text">{stale}.</p>}
    {currency.orders_with_unpriced > 0 && <p className="form-help">Заказов со строками без цены: {currency.orders_with_unpriced} — они учтены без этих строк.</p>}
    <div className="import-table-wrap"><table className="import-table">
      <thead><tr><th>Период</th><th>Поступления: долги клиентов</th><th>План: заказы</th><th>Выплаты: расходы</th><th>План: расходы</th><th>Остаток</th><th>Остаток с планом</th>{currency.currency !== "KZT" && <th>Остаток, KZT (оценка)</th>}</tr></thead>
      <tbody>
        {currency.periods.map(period => <tr key={period.start} className={period.gap ? "has-error" : ""}>
          <td>{periodLabel(period, calendar.step)}{period.gap ? <><br/><small className="load-warning-text">кассовый разрыв</small></> : period.gap_with_plan ? <><br/><small>разрыв с учётом плана</small></> : null}</td>
          <td>{cell(period.in_receivables, period.start, period.end)}</td><td>{cell(period.in_orders, period.start, period.end)}</td>
          <td>{cell(period.out_payables, period.start, period.end)}</td><td>{cell(period.out_planned, period.start, period.end)}</td>
          <td><strong>{period.closing == null ? "—" : money(period.closing)}</strong></td><td>{period.closing_with_plan == null ? "—" : money(period.closing_with_plan)}</td>
          {currency.currency !== "KZT" && <td>{period.closing_kzt == null ? "—" : money(period.closing_kzt)}</td>}
        </tr>)}
        <tr><td>После {cashDay(calendar.to)}</td><td>{outside(currency.later_in, "later")}</td><td>{Number(currency.later_orders) ? money(currency.later_orders) : "—"}</td>
          <td>{outside(currency.later_out, "later")}</td><td>{Number(currency.later_planned) ? money(currency.later_planned) : "—"}</td><td colSpan={currency.currency !== "KZT" ? 3 : 2}></td></tr>
        <tr className={Number(currency.overdue_in) || Number(currency.overdue_out) ? "has-error" : ""}><td>Просрочено</td><td>{outside(currency.overdue_in, "overdue")}</td><td>—</td>
          <td>{outside(currency.overdue_out, "overdue")}</td><td>—</td><td colSpan={currency.currency !== "KZT" ? 3 : 2}><small>не входит в остаток по неделям</small></td></tr>
        <tr><td>Срок оплаты не задан</td><td>—</td><td>—</td><td>{outside(currency.no_date_out, "no_date")}</td><td>—</td><td colSpan={currency.currency !== "KZT" ? 3 : 2}><small>не входит в остаток по неделям</small></td></tr>
      </tbody>
    </table></div>
    {(Number(currency.advances) > 0 || Number(currency.overpayments) > 0) && <p className="form-help">Справочно: авансы без зачёта {money(currency.advances, currency.currency)} · переплаты к возврату {money(currency.overpayments, currency.currency)}. В поступления и выплаты не входят.</p>}
  </section>;
}

type Supabase = Awaited<ReturnType<typeof requirePageUser>>["supabase"];

async function Items({ supabase, params, calendar }: { supabase: Supabase; params: ReturnType<typeof parseCashParams>; calendar: CashCalendar }) {
  const currency = calendar.currencies.find(item => item.currency_id === params.currency);
  if (!currency || !params.bucket) return <p className="empty-state">Выберите ячейку календаря.</p>;
  const { data, error } = await supabase.rpc("cash_calendar_items", { p_currency_id: currency.currency_id, p_bucket: params.bucket, p_from: params.from, p_to: params.to });
  const cell = data as CashCell | null;
  const title = params.bucket === "period" ? `${cashDay(params.from)} — ${cashDay(params.to)}` : params.bucket === "later" ? `после ${cashDay(calendar.to)}` : bucketTitle[params.bucket];
  return <section className="panel admin-section">
    <div className="panel-heading"><div><p className="eyebrow">Расшифровка · {currency.currency}</p><h2>{title}</h2></div><span className="page-count">{cell?.total ?? 0}</span></div>
    <p><Link href={`/finance/cash?step=${params.step}`}>← К календарю</Link></p>
    {error && <div className="login-error admin-message">Не удалось открыть строки календаря.</div>}
    {cell && <>
      <p className="form-help">Поступления {money(cell.amount_in, currency.currency)} · выплаты {money(cell.amount_out, currency.currency)}{cell.total > cell.items.length ? ` · показаны первые ${cell.items.length} из ${cell.total}` : ""}.</p>
      <div className="import-table-wrap"><table className="import-table">
        <thead><tr><th>Вид</th><th>Контрагент или документ</th><th>Дата в календаре</th><th>Срок</th><th>Поступление</th><th>Выплата</th><th>Примечание</th></tr></thead>
        <tbody>{cell.items.map((item, index) => {
          const href = cashItemHref(item);
          return <tr key={index}>
            <td>{cashKindLabel[item.kind]}</td><td>{href ? <Link href={href}>{item.ref_label ?? "—"}</Link> : item.ref_label ?? "—"}</td>
            <td>{item.date ? cashDay(item.date) : "срок не задан"}</td><td>{cashDay(item.due_date)}</td>
            <td>{item.direction === "in" ? money(item.amount) : "—"}</td><td>{item.direction === "out" ? money(item.amount) : "—"}</td><td>{cashItemNote(item)}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {!cell.items.length && <p className="empty-state">Строк нет.</p>}
    </>}
  </section>;
}

async function PlanFact({ supabase }: { supabase: Supabase }) {
  const { data, error } = await supabase.rpc("cash_plan_fact", { p_weeks: 8 });
  const report = data as CashPlanFact | null;
  if (error || !report) return <div className="login-error admin-message">Не удалось построить план-факт.</div>;
  return <section className="panel admin-section">
    <div className="panel-heading"><div><p className="eyebrow">{cashDay(report.from)} — {cashDay(report.to)}</p><h2>План-факт по прошедшим неделям</h2></div></div>
    <p className="form-help">«Ожидалось» — долги клиентов со сроком в эту неделю и расходы с плановой датой (иначе сроком) в эту неделю. «Поступило» — оплаты из банковской выписки, разнесённые на клиентов, и возвраты денег от получателей. «Выплачено» — внесённые оплаты и авансы; зачёт аванса деньгами не считается.</p>
    {report.currencies.map(currency => <div className="import-table-wrap" key={currency.currency}><table className="import-table">
      <caption>{currency.currency}</caption>
      <thead><tr><th>Неделя</th><th>Ожидалось поступлений</th><th>Поступило</th><th>Ожидалось выплат</th><th>Выплачено</th></tr></thead>
      <tbody>{currency.weeks.map(week => <tr key={week.start}><td>{periodLabel(week, "week")}</td><td>{money(week.plan_in)}</td><td>{money(week.fact_in)}</td><td>{money(week.plan_out)}</td><td>{money(week.fact_out)}</td></tr>)}</tbody>
    </table></div>)}
    {!report.currencies.length && <p className="empty-state">За эти недели нет ни сроков, ни оплат.</p>}
  </section>;
}

async function Accounts({ supabase, calendar }: { supabase: Supabase; calendar: CashCalendar }) {
  const [{ data }, { data: currencyRows }] = await Promise.all([
    supabase.rpc("cash_account_list"),
    supabase.from("currencies").select("id,code").eq("is_active", true).order("code"),
  ]);
  const accounts = (data ?? []) as CashAccount[];
  const currencies = (currencyRows ?? []) as Array<{ id: string; code: string }>;
  const active = accounts.filter(account => account.is_active);
  return <section className="panel admin-section" id="accounts">
    <div className="panel-heading"><div><p className="eyebrow">Вводятся вручную</p><h2>Счета и остатки</h2></div><span className="page-count">{active.length}</span></div>
    <p className="form-help">Nexus не обращается к банку: остаток каждого счёта вводится вручную на дату, прежние значения остаются в истории. Календарь начинается с последнего остатка каждого действующего счёта; пока у счёта нет остатка, разрыв по его валюте не определяется.</p>
    <div className="reference-list">{accounts.map(account => <article className="reference-row" key={account.id}>
      <div><strong>{account.name} · {account.currency}{account.is_active ? "" : " · закрыт"}</strong>
        <small>{account.bank ? `${account.bank} · ` : ""}{account.history.length ? account.history.slice(0, 3).map(item => `${money(item.amount, account.currency)} на ${cashDay(item.as_of)}${item.author ? ` (${item.author})` : ""}`).join("; ") : "остаток не введён"}</small></div>
      {calendar.can_manage && <form action={setCashAccountActive}><input type="hidden" name="account_id" value={account.id}/><input type="hidden" name="active" value={account.is_active ? "false" : "true"}/>
        <PendingSubmitButton pendingText="Сохраняем…" className="ghost" type="submit">{account.is_active ? "Закрыть счёт" : "Вернуть в расчёт"}</PendingSubmitButton></form>}
    </article>)}</div>
    {!accounts.length && <p className="empty-state">Счетов пока нет.</p>}
    {calendar.can_manage && <>
      {active.length > 0 && <form action={recordCashBalance} className="reference-form">
        <label>Счёт<select name="account_id" required>{active.map(account => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label>
        <label>Остаток на дату<input type="date" name="as_of" required max={calendar.today} defaultValue={calendar.today}/></label>
        <label>Сумма<input name="amount" inputMode="decimal" required placeholder="0,00"/></label>
        <label className="wide-field">Основание<input name="note" maxLength={1000} placeholder="Например: выписка банка на утро"/></label>
        <PendingSubmitButton pendingText="Записываем…" className="primary" type="submit">Записать остаток</PendingSubmitButton>
      </form>}
      <form action={saveCashAccount} className="reference-form">
        <label>Название счёта<input name="name" required minLength={2} maxLength={120} placeholder="Например: Kaspi, основной"/></label>
        <label>Банк<input name="bank" maxLength={120}/></label>
        <label>Валюта<select name="currency_id" required defaultValue={currencies.find(item => item.code === "KZT")?.id}>{currencies.map(item => <option key={item.id} value={item.id}>{item.code}</option>)}</select></label>
        <PendingSubmitButton pendingText="Сохраняем…" className="secondary" type="submit">Добавить счёт</PendingSubmitButton>
      </form>
      <form action={setCashGapAlertDays} className="inline-action">
        <label>Предупреждать о разрыве за, дней<input name="days" type="number" min={1} max={30} required defaultValue={calendar.gap_alert_days}/></label>
        <PendingSubmitButton pendingText="Сохраняем…" className="secondary" type="submit">Сохранить</PendingSubmitButton>
      </form>
      <p className="form-help">Раз в день Nexus проверяет календарь с правами каждого сотрудника с доступом к финансам: если остаток в какой-то валюте уходит ниже нуля в ближайшие {calendar.gap_alert_days} дн., приходит уведомление с валютой и неделей, без сумм; в Telegram — «Проверьте платёжный календарь».</p>
    </>}
  </section>;
}
