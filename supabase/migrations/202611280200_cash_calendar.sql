-- Block Б (2026-11-28): payment calendar — money in and out by week (or day) and currency.
-- Owner decisions of 2026-11-28 (damirator1-afk, defaults of the task accepted), see docs/cash-calendar.md:
--   * the balance of each bank account is entered by hand (account, currency, amount, date), with history; Nexus does
--     not ask the bank;
--   * 13 weeks ahead, days for the next two weeks;
--   * money in: open customer debts by due date (the receivables ledger, FIFO as the aging); expected from confirmed
--     orders not shipped yet (planned shipment + the customer's deferral) — a separate line;
--   * money out: the rest of confirmed expenses by the planned payment date, else the due date; planned expenses
--     (is_planned) — a separate line "план";
--   * overdue and "срок не задан" are separate, never spread over future weeks; advances not set off and overpayments
--     to be refunded are reference lines, never added (they are money already gone or not dated);
--   * currencies are never added together; tenge is an estimate column at today's official rate;
--   * payments for goods only with prices.purchase.view: without it the calendar has no goods payments and says so;
--     customer debts only with receivables.view;
--   * a planned payment date on an expense, changed with a reason and recorded in the audit log;
--   * a cash gap within N days (14 by default, set by finance.manage) notifies employees with finance.view once a
--     day: currency and week, no amounts; in Telegram as "Проверьте платёжный календарь".
-- The cost of goods does not depend on any of this: the cost inputs digest lists its expense columns explicitly.
begin;

-- Accounts and balances ------------------------------------------------------------------------------------------
create table if not exists public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 120),
  bank text check (bank is null or length(btrim(bank)) between 1 and 120),
  currency_id uuid not null references public.currencies(id) on delete restrict,
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists cash_accounts_name_unique on public.cash_accounts(lower(btrim(name)), currency_id);
create index if not exists cash_accounts_currency_idx on public.cash_accounts(currency_id);
create index if not exists cash_accounts_created_by_idx on public.cash_accounts(created_by);

create table if not exists public.cash_account_balances (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.cash_accounts(id) on delete restrict,
  as_of date not null,
  amount numeric(16, 2) not null,
  note text check (note is null or length(note) <= 1000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists cash_account_balances_account_idx on public.cash_account_balances(account_id, as_of desc, created_at desc);
create index if not exists cash_account_balances_created_by_idx on public.cash_account_balances(created_by);

create table if not exists public.cash_calendar_settings (
  id boolean primary key default true check (id),
  gap_alert_days integer not null default 14 check (gap_alert_days between 1 and 30),
  last_gap_check date,
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);
create index if not exists cash_calendar_settings_updated_by_idx on public.cash_calendar_settings(updated_by);
insert into public.cash_calendar_settings(id) values (true) on conflict (id) do nothing;

alter table public.cash_accounts enable row level security;
alter table public.cash_account_balances enable row level security;
alter table public.cash_calendar_settings enable row level security;
revoke all on public.cash_accounts, public.cash_account_balances, public.cash_calendar_settings
  from public, anon, authenticated, service_role;

-- Balances are history: never edited or deleted.
create or replace function private.guard_cash_history() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'История остатков на счетах неизменяема' using errcode = '42501';
end $$;
revoke all on function private.guard_cash_history() from public, anon, authenticated, service_role;
drop trigger if exists cash_account_balances_immutable on public.cash_account_balances;
create trigger cash_account_balances_immutable before update or delete on public.cash_account_balances
  for each row execute function private.guard_cash_history();

alter table public.expenses add column if not exists planned_payment_date date;

-- Notifications: the cash gap type ---------------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'deadline', 'overdue', 'approval_request', 'approval_decision', 'status_change', 'discrepancy',
  'low_shelf_life', 'document_uploaded', 'sync_error', 'system',
  'task_assigned', 'task_reassigned', 'stage_blocked', 'order_blocked', 'price_review', 'drive_new_files', 'cash_gap'));

-- Telegram (202611170600): the cash gap needs the employee's action; the object is the calendar (finance.view).
create or replace function private.telegram_notification_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['task_assigned', 'overdue', 'order_blocked', 'low_shelf_life', 'approval_request', 'price_review', 'cash_gap']
$$;
revoke all on function private.telegram_notification_types() from public, anon, authenticated, service_role;

create or replace function private.telegram_notification_allowed(p_user uuid, p_notification public.notifications)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_active_employee(p_user)
     and private.notification_visible_to(p_user, p_notification.entity_type, p_notification.shipment_id)
     and case p_notification.entity_type
           when 'sale' then private.user_has_permission(p_user, 'sales.view')
           when 'price_review' then private.user_has_permission(p_user, 'prices.purchase.view') and private.user_has_permission(p_user, 'pricing.list.manage')
           when 'shelf_life_control' then private.user_has_permission(p_user, 'inventory.view')
           when 'shipment_document_check' then private.user_has_permission(p_user, 'shipments.view') and private.user_has_permission(p_user, 'documents.view')
           when 'cash_calendar' then private.user_has_permission(p_user, 'finance.view')
           else true end
$$;
revoke all on function private.telegram_notification_allowed(uuid, public.notifications) from public, anon, authenticated, service_role;

-- Access -----------------------------------------------------------------------------------------------------------
create or replace function private.require_cash_view() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('finance.view')) then
    raise exception 'Нет доступа к платёжному календарю' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_cash_view() from public, anon, authenticated, service_role;

create or replace function private.require_cash_manage() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('finance.view')) or not (select private.has_permission('finance.manage')) then
    raise exception 'Нет права изменять данные платёжного календаря' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_cash_manage() from public, anon, authenticated, service_role;

-- Accounts and balances: changes -----------------------------------------------------------------------------------
create or replace function public.save_cash_account(p_name text, p_bank text, p_currency_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  perform private.require_cash_manage();
  if length(v_name) not between 2 and 120 then
    raise exception 'Укажите название счёта (от 2 до 120 символов)';
  end if;
  if not exists (select 1 from public.currencies where id = p_currency_id) then
    raise exception 'Укажите валюту счёта';
  end if;
  select id into v_id from public.cash_accounts where lower(btrim(name)) = lower(v_name) and currency_id = p_currency_id;
  if found then
    update public.cash_accounts set is_active = true where id = v_id;
    return v_id;
  end if;
  insert into public.cash_accounts(name, bank, currency_id, created_by)
  values (v_name, nullif(btrim(coalesce(p_bank, '')), ''), p_currency_id, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.save_cash_account(text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_cash_account(text, text, uuid) to authenticated;

create or replace function public.set_cash_account_active(p_account_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_cash_manage();
  if p_active is null then
    raise exception 'Укажите, действует ли счёт';
  end if;
  update public.cash_accounts set is_active = p_active where id = p_account_id;
  if not found then
    raise exception 'Счёт не найден';
  end if;
end $$;
revoke all on function public.set_cash_account_active(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_cash_account_active(uuid, boolean) to authenticated;

create or replace function public.record_cash_balance(p_account_id uuid, p_as_of date, p_amount numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_cash_manage();
  if not exists (select 1 from public.cash_accounts where id = p_account_id and is_active) then
    raise exception 'Счёт не найден или закрыт';
  end if;
  if p_as_of is null or p_as_of > private.business_today() then
    raise exception 'Дата остатка не может быть в будущем';
  end if;
  if p_amount is null or round(p_amount, 2) <> p_amount or abs(p_amount) >= 1e14 then
    raise exception 'Укажите остаток до копеек';
  end if;
  insert into public.cash_account_balances(account_id, as_of, amount, note, created_by)
  values (p_account_id, p_as_of, p_amount, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.record_cash_balance(uuid, date, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.record_cash_balance(uuid, date, numeric, text) to authenticated;

create or replace function public.set_cash_gap_alert_days(p_days integer)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_cash_manage();
  if p_days is null or p_days not between 1 and 30 then
    raise exception 'Укажите от 1 до 30 дней';
  end if;
  update public.cash_calendar_settings set gap_alert_days = p_days, updated_by = auth.uid(), updated_at = now() where id;
end $$;
revoke all on function public.set_cash_gap_alert_days(integer) from public, anon, authenticated, service_role;
grant execute on function public.set_cash_gap_alert_days(integer) to authenticated;

-- Accounts with their last ten balances, for the calendar page (finance.view).
create or replace function public.cash_account_list()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_cash_view();
  return coalesce((select jsonb_agg(jsonb_build_object(
           'id', a.id, 'name', a.name, 'bank', a.bank, 'currency', c.code, 'currency_id', a.currency_id, 'is_active', a.is_active,
           'history', (select coalesce(jsonb_agg(jsonb_build_object('as_of', b.as_of, 'amount', b.amount::text, 'note', b.note,
                                                                   'author', p.full_name, 'created_at', b.created_at)
                                                 order by b.as_of desc, b.created_at desc, b.id desc), '[]'::jsonb)
                         from (select x.* from public.cash_account_balances x where x.account_id = a.id
                                order by x.as_of desc, x.created_at desc, x.id desc limit 10) b
                         left join public.profiles p on p.id = b.created_by))
           order by a.is_active desc, case when c.code = 'KZT' then 0 else 1 end, c.code, a.name)
           from public.cash_accounts a join public.currencies c on c.id = a.currency_id), '[]'::jsonb);
end $$;
revoke all on function public.cash_account_list() from public, anon, authenticated, service_role;
grant execute on function public.cash_account_list() to authenticated;

-- Planned payment date of an expense: with a reason, in the audit log. Null returns to the due date.
create or replace function public.set_expense_planned_payment_date(p_expense_id uuid, p_date date, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.expenses;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_cash_manage();
  select * into e from public.expenses where id = p_expense_id for update;
  if not found then
    raise exception 'Расход не найден';
  end if;
  if e.expense_type = 'goods_cost' and not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к стоимости товара' using errcode = '42501';
  end if;
  if e.status in ('cancelled', 'reversed', 'paid') then
    raise exception 'Расход оплачен, отменён или сторнирован';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'Укажите причину (от 3 до 500 символов)';
  end if;
  if p_date is not distinct from e.planned_payment_date then
    raise exception 'Плановая дата оплаты не изменилась';
  end if;
  update public.expenses set planned_payment_date = p_date, updated_at = now() where id = e.id;
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (auth.uid(), 'expense_planned_payment_date', 'expenses', e.id::text,
          jsonb_build_object('planned_payment_date', e.planned_payment_date),
          jsonb_build_object('planned_payment_date', p_date),
          jsonb_build_object('reason', v_reason, 'due_date', e.due_date));
end $$;
revoke all on function public.set_expense_planned_payment_date(uuid, date, text) from public, anon, authenticated, service_role;
grant execute on function public.set_expense_planned_payment_date(uuid, date, text) to authenticated;

-- Planned payment dates of the expenses of a payee (null: expenses without a payee), with the last change.
create or replace function public.expense_payment_plans(p_payee_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_cash_view();
  return coalesce((select jsonb_agg(jsonb_build_object(
           'expense_id', e.id, 'planned_payment_date', e.planned_payment_date,
           'changed_at', a.created_at, 'changed_by', pr.full_name, 'reason', a.metadata ->> 'reason'))
         from public.expenses e
         left join lateral (select x.* from public.audit_log x
                             where x.entity_type = 'expenses' and x.entity_id = e.id::text and x.action = 'expense_planned_payment_date'
                             order by x.created_at desc limit 1) a on true
         left join public.profiles pr on pr.id = a.actor_user_id
        where e.payee_counterparty_id is not distinct from p_payee_id
          and e.status in ('confirmed', 'allocated')
          and (e.expense_type <> 'goods_cost' or (select private.has_permission('prices.purchase.view')))), '[]'::jsonb);
end $$;
revoke all on function public.expense_payment_plans(uuid) from public, anon, authenticated, service_role;
grant execute on function public.expense_payment_plans(uuid) to authenticated;

-- Items of the calendar --------------------------------------------------------------------------------------------
-- Open customer debts by due date: the ledger of each customer, credits applied to the oldest debts first (the rule of
-- customer_aging_of, 202611250300).
create or replace function private.cash_receivable_items()
returns table(customer_id uuid, currency_id uuid, due_date date, amount numeric)
language sql stable security definer set search_path = '' set jit = off as $$
  with l as (
    select c.id as customer_id, x.*
      from public.counterparties c
      cross join lateral private.customer_ledger(c.id) x
     where 'customer' = any(c.roles)
       and x.entry_date <= private.receivables_today()
  ), credits as (
    select l.customer_id, l.currency_id, -sum(l.amount) as total from l where l.amount < 0 group by 1, 2
  ), debts as (
    select l.customer_id, l.currency_id, l.due_date, l.amount,
           sum(l.amount) over (partition by l.customer_id, l.currency_id
                               order by l.due_date, l.entry_date, l.ref_id rows unbounded preceding) as running
      from l where l.amount > 0
  )
  select d.customer_id, d.currency_id, d.due_date, greatest(0, least(d.amount, d.running - coalesce(c.total, 0)))
    from debts d
    left join credits c on c.customer_id = d.customer_id and c.currency_id = d.currency_id
   where greatest(0, least(d.amount, d.running - coalesce(c.total, 0))) > 0
$$;
revoke all on function private.cash_receivable_items() from public, anon, authenticated, service_role;

-- Every dated or undated money item. kind: receivable / order (in), payable / planned (out). date null = not dated.
create or replace function private.cash_items(p_receivables boolean, p_goods boolean)
returns table(kind text, direction text, ref_type text, ref_id uuid, ref_label text, counterparty_id uuid, currency_id uuid,
              item_date date, due_date date, amount numeric, note text)
language sql stable security definer set search_path = '' set jit = off as $$
  with today as (select private.business_today() as d)
  select 'receivable'::text, 'in'::text, 'customer'::text, r.customer_id, coalesce(c.short_name, c.legal_name), r.customer_id,
         r.currency_id, r.due_date, r.due_date, r.amount, null::text
    from private.cash_receivable_items() r
    join public.counterparties c on c.id = r.customer_id
   where p_receivables
  union all
  select 'order', 'in', 'sale', s.id, s.sale_number, s.customer_id, private.sale_currency(s.id),
         greatest(s.planned_shipment_date + private.sale_deferral_days(s.id, s.planned_shipment_date), (select d from today)),
         s.planned_shipment_date + private.sale_deferral_days(s.id, s.planned_shipment_date),
         a.amount, case when a.unpriced_lines > 0 then 'unpriced_lines:' || a.unpriced_lines end
    from public.sales s
    cross join lateral private.sale_amount(s.id) a
   where p_receivables and s.status in ('reserved', 'confirmed') and a.amount > 0 and private.sale_currency(s.id) is not null
  union all
  -- The rule of payable_expenses (202611170400) with the goods filter by the given right, not by the session: the
  -- daily gap control runs without a user.
  select 'payable', 'out', 'expense', e.id, coalesce(pc.short_name, pc.legal_name), e.payee_counterparty_id, e.currency_id,
         coalesce(e.planned_payment_date, e.due_date), e.due_date, e.amount - pd.paid, e.expense_type
    from public.expenses e
    cross join lateral (select private.expense_paid_amount(e.id) as paid) pd
    left join public.counterparties pc on pc.id = e.payee_counterparty_id
   where not e.is_planned and e.status in ('confirmed', 'allocated', 'paid')
     and e.amount > pd.paid
     and (p_goods or e.expense_type <> 'goods_cost')
  union all
  -- A planned expense is an estimate of the shipment (or customer) costs: it stops counting once an actual expense of the
  -- same type is entered for the same shipment and customer, so the plan and the fact are never paid twice.
  select 'planned', 'out', 'expense', e.id, coalesce(pc.short_name, pc.legal_name), e.payee_counterparty_id, e.currency_id,
         greatest(coalesce(e.planned_payment_date, e.due_date, e.incurred_at), (select d from today)),
         e.due_date, e.amount, e.expense_type
    from public.expenses e
    left join public.counterparties pc on pc.id = e.payee_counterparty_id
   where e.is_planned and e.status not in ('cancelled', 'reversed', 'paid')
     and (p_goods or e.expense_type <> 'goods_cost')
     and not exists (select 1 from public.expenses f
                      where not f.is_planned and f.status not in ('cancelled', 'reversed')
                        and f.expense_type = e.expense_type
                        and f.shipment_id is not distinct from e.shipment_id
                        and f.attributed_customer_id is not distinct from e.attributed_customer_id)
$$;
revoke all on function private.cash_items(boolean, boolean) from public, anon, authenticated, service_role;

-- The calendar for given rights. Rows per currency; periods from today (days) or from the Monday of this week.
create or replace function private.cash_calendar_data(p_step text, p_periods integer, p_receivables boolean, p_goods boolean)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.business_today();
  v_kzt uuid := (select id from public.currencies where code = 'KZT');
  v_start date;
  v_len integer;
  v_end date;
  v_result jsonb;
begin
  if p_step = 'day' then
    v_start := v_today; v_len := 1;
  else
    v_start := date_trunc('week', v_today)::date; v_len := 7;
  end if;
  v_end := v_start + v_len * p_periods - 1;

  with items as (
    select * from private.cash_items(p_receivables, p_goods)
  ), periods as (
    select g as n, v_start + (g - 1) * v_len as period_start, v_start + g * v_len - 1 as period_end
      from generate_series(1, p_periods) g
  ), balances as (
    select a.currency_id, a.id as account_id, a.name, a.bank, b.as_of, b.amount
      from public.cash_accounts a
      left join lateral (select x.as_of, x.amount from public.cash_account_balances x
                          where x.account_id = a.id and x.as_of <= v_today
                          order by x.as_of desc, x.created_at desc, x.id desc limit 1) b on true
     where a.is_active
  ), free_payments as (
    -- Reference only: open advances (202611170700) and overpayments of reversed expenses (202611210200), with the goods
    -- filter by the given right. Already paid, so never added to the flows.
    select p.kind, p.currency_id, private.payment_unapplied(p.id) as remaining
      from public.payments p
     where ((p.kind = 'advance' and (p_goods or p.advance_for <> 'goods'))
            or (p.kind = 'payment' and private.payment_released_kind(p.id) is not null
                and (p_goods or private.payment_released_kind(p.id) = 'services')))
       and private.payment_unapplied(p.id) > 0
  ), currencies as (
    select distinct i.currency_id from items i
    union select b.currency_id from balances b
    union select f.currency_id from free_payments f
  ), opening as (
    select c.currency_id,
           case when count(b.account_id) > 0 and count(b.account_id) = count(b.as_of) then sum(b.amount) end as amount,
           min(b.as_of) as as_of,
           count(b.account_id) as accounts,
           count(b.account_id) - count(b.as_of) as accounts_without_balance,
           coalesce(jsonb_agg(jsonb_build_object('id', b.account_id, 'name', b.name, 'bank', b.bank, 'as_of', b.as_of,
                                                 'amount', b.amount::text) order by b.name) filter (where b.account_id is not null),
                    '[]'::jsonb) as list
      from currencies c
      left join balances b on b.currency_id = c.currency_id
     group by c.currency_id
  ), flows as (
    select c.currency_id, p.n, p.period_start, p.period_end,
           coalesce(sum(i.amount) filter (where i.kind = 'receivable'), 0) as in_receivables,
           coalesce(sum(i.amount) filter (where i.kind = 'order'), 0) as in_orders,
           coalesce(sum(i.amount) filter (where i.kind = 'payable'), 0) as out_payables,
           coalesce(sum(i.amount) filter (where i.kind = 'planned'), 0) as out_planned
      from currencies c
      cross join periods p
      left join items i on i.currency_id = c.currency_id and i.item_date between greatest(p.period_start, v_today) and p.period_end
     group by c.currency_id, p.n, p.period_start, p.period_end
  ), running as (
    select f.*,
           sum(f.in_receivables - f.out_payables) over w as net_confirmed,
           sum(f.in_receivables + f.in_orders - f.out_payables - f.out_planned) over w as net_with_plan
      from flows f
    window w as (partition by f.currency_id order by f.n rows unbounded preceding)
  ), outside as (
    select c.currency_id,
           coalesce(sum(i.amount) filter (where i.kind = 'receivable' and i.item_date < v_today), 0) as overdue_in,
           coalesce(sum(i.amount) filter (where i.kind = 'payable' and i.item_date < v_today), 0) as overdue_out,
           coalesce(sum(i.amount) filter (where i.kind = 'payable' and i.item_date is null), 0) as no_date_out,
           coalesce(sum(i.amount) filter (where i.kind = 'receivable' and i.item_date > v_end), 0) as later_in,
           coalesce(sum(i.amount) filter (where i.kind = 'order' and i.item_date > v_end), 0) as later_orders,
           coalesce(sum(i.amount) filter (where i.kind = 'payable' and i.item_date > v_end), 0) as later_out,
           coalesce(sum(i.amount) filter (where i.kind = 'planned' and i.item_date > v_end), 0) as later_planned,
           count(*) filter (where i.kind = 'order' and i.note like 'unpriced_lines:%') as orders_with_unpriced
      from currencies c
      left join items i on i.currency_id = c.currency_id
     group by c.currency_id
  ), reference as (
    select c.currency_id,
           coalesce((select sum(a.remaining) from free_payments a
                      where a.currency_id = c.currency_id and a.kind = 'advance'), 0) as advances,
           coalesce((select sum(o.remaining) from free_payments o
                      where o.currency_id = c.currency_id and o.kind = 'payment'), 0) as overpayments
      from currencies c
  ), rates as (
    select c.currency_id, r.rate
      from currencies c
      cross join lateral private.official_conversion(c.currency_id, v_kzt, v_today) r
  )
  select jsonb_build_object(
    'today', v_today, 'step', p_step, 'from', v_start, 'to', v_end, 'receivables', p_receivables, 'goods', p_goods,
    'currencies', coalesce(jsonb_agg(jsonb_build_object(
      'currency_id', cur.id, 'currency', cur.code,
      'opening', jsonb_build_object('amount', o.amount::text, 'as_of', o.as_of, 'accounts', o.accounts,
                                    'accounts_without_balance', o.accounts_without_balance, 'list', o.list),
      'rate_kzt', r.rate::text,
      'overdue_in', x.overdue_in::text, 'overdue_out', x.overdue_out::text, 'no_date_out', x.no_date_out::text,
      'later_in', x.later_in::text, 'later_orders', x.later_orders::text, 'later_out', x.later_out::text,
      'later_planned', x.later_planned::text, 'orders_with_unpriced', x.orders_with_unpriced,
      'advances', ref.advances::text, 'overpayments', ref.overpayments::text,
      'first_gap', (select min(q.period_start) from running q where q.currency_id = cur.id and o.amount is not null
                      and o.amount + q.net_confirmed < 0),
      'first_gap_with_plan', (select min(q.period_start) from running q where q.currency_id = cur.id and o.amount is not null
                                and o.amount + q.net_with_plan < 0),
      'periods', (select jsonb_agg(jsonb_build_object(
                    'start', q.period_start, 'end', q.period_end,
                    'in_receivables', q.in_receivables::text, 'in_orders', q.in_orders::text,
                    'out_payables', q.out_payables::text, 'out_planned', q.out_planned::text,
                    'closing', case when o.amount is not null then (o.amount + q.net_confirmed)::text end,
                    'closing_with_plan', case when o.amount is not null then (o.amount + q.net_with_plan)::text end,
                    'closing_kzt', case when o.amount is not null and r.rate is not null then round((o.amount + q.net_confirmed) * r.rate, 2)::text end,
                    'gap', o.amount is not null and o.amount + q.net_confirmed < 0,
                    'gap_with_plan', o.amount is not null and o.amount + q.net_with_plan < 0) order by q.n)
                  from running q where q.currency_id = cur.id))
      order by case when cur.code = 'KZT' then 0 else 1 end, cur.code), '[]'::jsonb))
    into v_result
    from currencies c
    join public.currencies cur on cur.id = c.currency_id
    join opening o on o.currency_id = c.currency_id
    join outside x on x.currency_id = c.currency_id
    join reference ref on ref.currency_id = c.currency_id
    left join rates r on r.currency_id = c.currency_id;
  return v_result;
end $$;
revoke all on function private.cash_calendar_data(text, integer, boolean, boolean) from public, anon, authenticated, service_role;

-- Calendar for the employee: finance.view; customer debts with receivables.view; goods payments with prices.purchase.view.
create or replace function public.cash_calendar(p_step text default 'week', p_periods integer default 13)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare v_result jsonb;
begin
  perform private.require_cash_view();
  if p_step is null or p_step not in ('week', 'day') then
    raise exception 'Выберите шаг: неделя или день';
  end if;
  if p_periods is null or (p_step = 'week' and p_periods not between 1 and 26) or (p_step = 'day' and p_periods not between 1 and 31) then
    raise exception 'Укажите до 26 недель или до 31 дня';
  end if;
  v_result := private.cash_calendar_data(p_step, p_periods,
                (select private.has_permission('receivables.view')),
                (select private.has_permission('prices.purchase.view')));
  -- The same periods as one flat list with the currency, for the assistant's reports (they read one level of rows).
  return v_result
         || jsonb_build_object('can_manage', (select private.has_permission('finance.manage')),
                               'gap_alert_days', (select gap_alert_days from public.cash_calendar_settings where id),
                               'flat_periods', coalesce((select jsonb_agg(x.p || jsonb_build_object('currency', c.c ->> 'currency') order by c.n, x.n)
                                                           from jsonb_array_elements(v_result -> 'currencies') with ordinality c(c, n)
                                                           cross join jsonb_array_elements(c.c -> 'periods') with ordinality x(p, n)), '[]'::jsonb));
end $$;
revoke all on function public.cash_calendar(text, integer) from public, anon, authenticated, service_role;
grant execute on function public.cash_calendar(text, integer) to authenticated;

-- What makes a cell: the items of a currency in a period ('period'), overdue ('overdue'), not dated ('no_date') or after
-- the horizon ('later', p_from is the first day after it). Amounts of goods only with prices.purchase.view. The first 500
-- items, with the number and the sums of all of them.
create or replace function public.cash_calendar_items(p_currency_id uuid, p_bucket text, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare v_today date := private.business_today();
begin
  perform private.require_cash_view();
  if p_bucket is null or p_bucket not in ('period', 'overdue', 'no_date', 'later') then
    raise exception 'Некорректная группа строк календаря';
  end if;
  if p_bucket = 'period' and (p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366) then
    raise exception 'Укажите период до года';
  end if;
  if p_bucket = 'later' and p_from is null then
    raise exception 'Укажите, после какой даты';
  end if;
  return (
    with x as (
      select i.*, row_number() over (order by i.item_date nulls first, i.direction, i.kind, i.ref_label, i.ref_id) as rn
        from private.cash_items((select private.has_permission('receivables.view')), (select private.has_permission('prices.purchase.view'))) i
       where i.currency_id = p_currency_id
         and case p_bucket
               when 'period' then i.item_date between greatest(p_from, v_today) and p_to
               when 'overdue' then i.item_date < v_today and i.kind in ('receivable', 'payable')
               when 'no_date' then i.item_date is null
               else i.item_date >= p_from end
    )
    select jsonb_build_object(
      'total', count(*), 'limit', 500,
      'amount_in', coalesce(sum(x.amount) filter (where x.direction = 'in'), 0)::text,
      'amount_out', coalesce(sum(x.amount) filter (where x.direction = 'out'), 0)::text,
      'items', coalesce(jsonb_agg(jsonb_build_object(
                 'kind', x.kind, 'direction', x.direction, 'ref_type', x.ref_type, 'ref_id', x.ref_id, 'ref_label', x.ref_label,
                 'counterparty_id', x.counterparty_id, 'date', x.item_date, 'due_date', x.due_date, 'amount', x.amount::text, 'note', x.note)
                 order by x.rn) filter (where x.rn <= 500), '[]'::jsonb))
      from x);
end $$;
revoke all on function public.cash_calendar_items(uuid, text, date, date) from public, anon, authenticated, service_role;
grant execute on function public.cash_calendar_items(uuid, text, date, date) to authenticated;

-- Plan and fact of past weeks: what was due in the week (customer debts by due date, expenses by planned or due date)
-- against what came (matched bank payments, refunds from payees) and what was paid (payments, advances included).
create or replace function public.cash_plan_fact(p_weeks integer default 4)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.business_today();
  v_first date;
  v_receivables boolean := (select private.has_permission('receivables.view'));
  v_goods boolean := (select private.has_permission('prices.purchase.view'));
  v_result jsonb;
begin
  perform private.require_cash_view();
  if p_weeks is null or p_weeks not between 1 and 26 then
    raise exception 'Укажите от 1 до 26 недель';
  end if;
  v_first := date_trunc('week', v_today)::date - 7 * p_weeks;

  with weeks as (
    select v_first + (g - 1) * 7 as week_start, v_first + g * 7 - 1 as week_end from generate_series(1, p_weeks) g
  ), ledger as (
    select x.* from public.counterparties c cross join lateral private.customer_ledger(c.id) x
     where v_receivables and 'customer' = any(c.roles)
  ), facts as (
    select 'plan_in'::text as kind, l.currency_id, l.due_date as d, l.amount from ledger l
     where l.amount > 0 and l.due_date >= v_first and l.due_date < date_trunc('week', v_today)::date
    union all
    select 'fact_in', l.currency_id, l.entry_date, -l.amount from ledger l
     where l.kind = 'payment' and l.entry_date >= v_first and l.entry_date < date_trunc('week', v_today)::date
    union all
    select 'fact_in', p.currency_id, r.received_on, r.amount
      from public.payment_refunds r join public.payments p on p.id = r.payment_id
     where r.received_on >= v_first and r.received_on < date_trunc('week', v_today)::date
       and (v_goods or (coalesce(p.advance_for, '') <> 'goods'
                        and not exists (select 1 from public.payment_applications a join public.expenses e on e.id = a.expense_id
                                         where a.payment_id = p.id and e.expense_type = 'goods_cost')))
    union all
    select 'plan_out', e.currency_id, coalesce(e.planned_payment_date, e.due_date), e.amount
      from public.expenses e
     where not e.is_planned and e.status in ('confirmed', 'allocated', 'paid')
       and coalesce(e.planned_payment_date, e.due_date) >= v_first
       and coalesce(e.planned_payment_date, e.due_date) < date_trunc('week', v_today)::date
       and (v_goods or e.expense_type <> 'goods_cost')
    union all
    select 'fact_out', p.currency_id, p.paid_on, p.amount
      from public.payments p
     where p.paid_on >= v_first and p.paid_on < date_trunc('week', v_today)::date
       and (v_goods or (coalesce(p.advance_for, '') <> 'goods'
                        and not exists (select 1 from public.payment_applications a join public.expenses e on e.id = a.expense_id
                                         where a.payment_id = p.id and e.expense_type = 'goods_cost')))
  ), currencies as (
    select distinct f.currency_id from facts f
  ), sums as (
    select c.currency_id, w.week_start, w.week_end,
           coalesce(sum(f.amount) filter (where f.kind = 'plan_in'), 0) as plan_in,
           coalesce(sum(f.amount) filter (where f.kind = 'fact_in'), 0) as fact_in,
           coalesce(sum(f.amount) filter (where f.kind = 'plan_out'), 0) as plan_out,
           coalesce(sum(f.amount) filter (where f.kind = 'fact_out'), 0) as fact_out
      from currencies c
      cross join weeks w
      left join facts f on f.currency_id = c.currency_id and f.d between w.week_start and w.week_end
     group by c.currency_id, w.week_start, w.week_end
  )
  select jsonb_build_object(
    'from', v_first, 'to', date_trunc('week', v_today)::date - 1, 'receivables', v_receivables, 'goods', v_goods,
    'currencies', coalesce(jsonb_agg(jsonb_build_object(
      'currency', cur.code,
      'weeks', (select jsonb_agg(jsonb_build_object(
                  'start', s.week_start, 'end', s.week_end, 'plan_in', s.plan_in::text, 'fact_in', s.fact_in::text,
                  'plan_out', s.plan_out::text, 'fact_out', s.fact_out::text) order by s.week_start)
                from sums s where s.currency_id = c.currency_id))
      order by case when cur.code = 'KZT' then 0 else 1 end, cur.code), '[]'::jsonb))
    into v_result
    from currencies c join public.currencies cur on cur.id = c.currency_id;
  return v_result;
end $$;
revoke all on function public.cash_plan_fact(integer) from public, anon, authenticated, service_role;
grant execute on function public.cash_plan_fact(integer) to authenticated;

-- Cash gap control (service role, once a business day): for every employee with finance.view, the calendar with that
-- employee's rights; a currency whose balance goes below zero within N days gives one notification a day — currency and
-- week, no amounts. Returns the number of notifications created; 0 when already checked today.
create or replace function public.run_cash_gap_control()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := private.business_today();
  v_settings public.cash_calendar_settings;
  v_horizon date;
  v_cache jsonb := '{}'::jsonb;
  v_key text;
  v_data jsonb;
  v_currency jsonb;
  v_gap date;
  u record;
  v_count integer := 0;
begin
  select * into v_settings from public.cash_calendar_settings where id for update;
  if v_settings.last_gap_check is not distinct from v_today then
    return 0;
  end if;
  update public.cash_calendar_settings set last_gap_check = v_today where id;
  v_horizon := v_today + v_settings.gap_alert_days;
  for u in
    select p.id,
           private.user_has_permission(p.id, 'receivables.view') as receivables,
           private.user_has_permission(p.id, 'prices.purchase.view') as goods
      from public.profiles p
     where private.is_active_employee(p.id) and private.user_has_permission(p.id, 'finance.view')
     order by p.id
  loop
    v_key := u.receivables::text || ':' || u.goods::text;
    if not v_cache ? v_key then
      v_cache := v_cache || jsonb_build_object(v_key, private.cash_calendar_data('day', v_settings.gap_alert_days + 1, u.receivables, u.goods));
    end if;
    v_data := v_cache -> v_key;
    for v_currency in select value from jsonb_array_elements(v_data -> 'currencies') loop
      v_gap := (v_currency ->> 'first_gap')::date;
      if v_gap is not null and v_gap <= v_horizon then
        if private.notify(u.id, 'cash_gap', 'Кассовый разрыв: ' || (v_currency ->> 'currency'),
             format('По платёжному календарю остаток %s уходит ниже нуля %s (неделя с %s). '
                    'Откройте календарь и проверьте выплаты и поступления.',
                    v_currency ->> 'currency', to_char(v_gap, 'DD.MM.YYYY'), to_char(date_trunc('week', v_gap), 'DD.MM.YYYY')),
             'cash_calendar', null, null,
             'cash_gap:' || (v_currency ->> 'currency') || ':' || v_today) then
          v_count := v_count + 1;
        end if;
      end if;
    end loop;
  end loop;
  return v_count;
end $$;
revoke all on function public.run_cash_gap_control() from public, anon, authenticated, service_role;
grant execute on function public.run_cash_gap_control() to service_role;

commit;
