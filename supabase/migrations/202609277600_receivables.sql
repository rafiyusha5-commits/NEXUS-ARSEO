-- Receivables: what each customer owes, since when and how late.
--
-- Accounting lives in 1С, the money arrives at Freedom Bank; Nexus keeps a customer ledger built from:
--   * opening balance  — the 1С report on settlements with customers as of a date (debts before that date);
--   * shipments        — shipped customer orders at the order price, due after the deferral of the contract
--                        (contract term «payment_terms», days) or of the customer card;
--   * returns          — active returns from customers at the order price reduce the debt;
--   * payments         — incoming payments from the bank statement (1С exchange file), matched to the customer
--                        by BIN or by the order number in the purpose, or by hand;
--   * adjustments      — manual corrections with a reason (e.g. after a reconciliation act).
-- Entries dated on or before the opening balance date are already inside that balance and are left out.
-- Payments close the oldest debts first (FIFO by due date); a negative balance is an advance from the customer.
--
-- Before a customer order is confirmed, the customer is checked for overdue debt and for the credit limit.
-- Nothing is blocked silently: the employee sees the warning and either holds the order or records the decision
-- to proceed with a reason; the accountants are notified.

insert into public.permissions(code,module,action,name,description) values
  ('receivables.view','receivables','view','Дебиторка: просмотр','Долги покупателей, акты сверки, выписки банка'),
  ('receivables.manage','receivables','manage','Дебиторка: ведение','Загрузка выписок и сальдо, разнесение оплат, корректировки, условия оплаты')
on conflict (code) do update set name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where (p.code='receivables.view' and r.code in ('administrator','director','executive_director','commercial_director','accountant'))
   or (p.code='receivables.manage' and r.code in ('administrator','director','executive_director','accountant'))
on conflict (role_id,permission_id) do nothing;

-- The moment an order left the warehouse. The fulfillment of customer orders writes it too (same definition);
-- the trigger below fills it for any other way an order becomes shipped.
alter table public.sales add column if not exists shipped_at timestamptz;

create table if not exists public.customer_credit_terms (
  customer_id uuid primary key references public.counterparties(id) on delete restrict,
  credit_limit numeric(16,2) check (credit_limit is null or credit_limit >= 0),
  limit_currency_id uuid references public.currencies(id) on delete restrict,
  default_deferral_days integer check (default_deferral_days is null or default_deferral_days between 0 and 365),
  updated_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  check ((credit_limit is null) = (limit_currency_id is null))
);

create table if not exists public.customer_opening_balances (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.counterparties(id) on delete restrict,
  currency_id uuid not null references public.currencies(id) on delete restrict,
  as_of date not null,
  amount numeric(16,2) not null,
  due_date date,
  contract_number text check (contract_number is null or length(contract_number) <= 200),
  source_file_name text check (source_file_name is null or length(source_file_name) <= 255),
  imported_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  superseded_by uuid references public.customer_opening_balances(id) on delete restrict
);
create unique index if not exists customer_opening_balances_active
  on public.customer_opening_balances(customer_id, currency_id) where superseded_at is null;

create table if not exists public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null check (length(file_name) between 1 and 255),
  file_sha256 text not null unique check (file_sha256 ~ '^[0-9a-f]{64}$'),
  account_number text check (account_number is null or length(account_number) <= 64),
  period_from date,
  period_to date,
  currency_id uuid not null references public.currencies(id) on delete restrict,
  lines_total integer not null default 0,
  lines_new integer not null default 0,
  lines_matched integer not null default 0,
  imported_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.bank_statement_imports(id) on delete restrict,
  line_key text not null unique,
  doc_number text check (doc_number is null or length(doc_number) <= 64),
  doc_date date not null,
  amount numeric(16,2) not null check (amount > 0),
  currency_id uuid not null references public.currencies(id) on delete restrict,
  payer_name text check (payer_name is null or length(payer_name) <= 500),
  payer_bin text check (payer_bin is null or length(payer_bin) <= 32),
  payer_account text check (payer_account is null or length(payer_account) <= 64),
  purpose text check (purpose is null or length(purpose) <= 2000),
  status text not null default 'unmatched' check (status in ('unmatched','matched','ignored')),
  customer_id uuid references public.counterparties(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  matched_how text check (matched_how in ('auto_bin','auto_order','manual')),
  note text check (note is null or length(note) <= 500),
  resolved_by uuid references public.profiles(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'matched') = (customer_id is not null)),
  check ((status = 'matched') = (matched_how is not null)),
  check (sale_id is null or status = 'matched'),
  check (status <> 'ignored' or nullif(btrim(note), '') is not null)
);
create index if not exists bank_statement_lines_customer_idx on public.bank_statement_lines(customer_id) where status = 'matched';
create index if not exists bank_statement_lines_status_idx on public.bank_statement_lines(status, doc_date desc);

create table if not exists public.customer_balance_adjustments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.counterparties(id) on delete restrict,
  currency_id uuid not null references public.currencies(id) on delete restrict,
  entry_date date not null,
  amount numeric(16,2) not null check (amount <> 0),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists customer_balance_adjustments_customer_idx on public.customer_balance_adjustments(customer_id);

create table if not exists public.customer_reconciliation_acts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.counterparties(id) on delete restrict,
  currency_id uuid not null references public.currencies(id) on delete restrict,
  as_of date not null,
  act_balance numeric(16,2) not null,
  nexus_balance numeric(16,2) not null,
  note text check (note is null or length(note) <= 500),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists customer_reconciliation_acts_customer_idx on public.customer_reconciliation_acts(customer_id, as_of desc);

create table if not exists public.sale_credit_decisions (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  issues jsonb not null,
  decided_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  decided_at timestamptz not null default now()
);
create index if not exists sale_credit_decisions_sale_idx on public.sale_credit_decisions(sale_id, decided_at desc);

alter table public.customer_credit_terms enable row level security;
alter table public.customer_opening_balances enable row level security;
alter table public.bank_statement_imports enable row level security;
alter table public.bank_statement_lines enable row level security;
alter table public.customer_balance_adjustments enable row level security;
alter table public.customer_reconciliation_acts enable row level security;
alter table public.sale_credit_decisions enable row level security;
revoke all on public.customer_credit_terms, public.customer_opening_balances, public.bank_statement_imports,
  public.bank_statement_lines, public.customer_balance_adjustments, public.customer_reconciliation_acts,
  public.sale_credit_decisions from anon, authenticated, service_role;
grant select on public.customer_credit_terms, public.customer_opening_balances, public.bank_statement_imports,
  public.bank_statement_lines, public.customer_balance_adjustments, public.customer_reconciliation_acts,
  public.sale_credit_decisions to authenticated;

do $$ declare t text; begin
  foreach t in array array['customer_credit_terms','customer_opening_balances','bank_statement_imports','bank_statement_lines',
                           'customer_balance_adjustments','customer_reconciliation_acts'] loop
    execute format('drop policy if exists "receivables read" on public.%I', t);
    execute format('create policy "receivables read" on public.%I for select to authenticated using ((select private.has_permission(%L)))', t, 'receivables.view');
  end loop;
  foreach t in array array['customer_credit_terms','customer_opening_balances','bank_statement_imports','bank_statement_lines',
                           'customer_balance_adjustments','customer_reconciliation_acts','sale_credit_decisions'] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I', t, t);
    execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()', t, t);
  end loop;
end $$;
-- The decision to proceed is part of the order: whoever sees the order sees why it went ahead.
drop policy if exists "sales users view credit decisions" on public.sale_credit_decisions;
create policy "sales users view credit decisions" on public.sale_credit_decisions for select to authenticated
  using ((select private.has_permission('sales.view')) or (select private.has_permission('receivables.view')));

comment on table public.customer_opening_balances is 'Debts of customers from the 1С settlements report as of a date; a newer import supersedes the older row';
comment on table public.bank_statement_lines is 'Incoming payments from bank statements (1С exchange format) and how they were matched to customers';
comment on table public.sale_credit_decisions is 'Decisions to confirm an order despite overdue debt or an exceeded credit limit';

-- Business day in Kazakhstan.
create or replace function private.receivables_today()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Almaty')::date
$$;

create or replace function private.currency_code(p_currency_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select code from public.currencies where id = p_currency_id
$$;

create or replace function private.currency_by_code(p_code text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.currencies where code = upper(btrim(coalesce(p_code, 'KZT')));
  if v_id is null then raise exception 'Неизвестная валюта: %', p_code; end if;
  return v_id;
end $$;

-- 1234567.5 → «1 234 567,50», for messages.
create or replace function private.money_text(p_value numeric)
returns text language sql immutable set search_path = '' as $$
  select replace(btrim(to_char(round(p_value, 2), 'FM999 999 999 999 990.00')), '.', ',')
$$;

-- Currency the customer pays an order in: the order, then the contract, then the customer card, then tenge.
create or replace function private.sale_currency(p_sale_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(s.currency_id, c.currency_id, cp.default_currency_id, (select id from public.currencies where code = 'KZT'))
  from public.sales s
  join public.counterparties cp on cp.id = s.customer_id
  left join public.contracts c on c.id = s.contract_id
  where s.id = p_sale_id
$$;

-- Days of deferral for an order shipped on a date: the payment term of the order's contract valid on that date;
-- without a contract on the order, the latest such term of the customer's active sale contracts; then the
-- customer card; else payment on the day of shipment.
create or replace function private.sale_deferral_days(p_sale_id uuid, p_on date)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select round(ct.value_numeric)::integer
     from public.sales s
     join public.contracts c on c.id = s.contract_id or (s.contract_id is null and c.counterparty_id = s.customer_id
                                                         and c.type = 'sale' and c.status = 'active' and c.archived_at is null)
     join public.contract_terms ct on ct.contract_id = c.id
     where s.id = p_sale_id and ct.term_type = 'payment_terms' and ct.product_id is null and ct.value_numeric >= 0
       and (ct.valid_from is null or ct.valid_from <= p_on) and (ct.valid_to is null or ct.valid_to >= p_on)
     order by (c.id = s.contract_id) desc, ct.valid_from desc nulls last, c.sign_date desc nulls last, ct.created_at desc
     limit 1),
    (select t.default_deferral_days from public.customer_credit_terms t join public.sales s on s.customer_id = t.customer_id
     where s.id = p_sale_id),
    0)
$$;

-- Amount of an order: shipped quantities (fulfilled reservations in the order unit) or, before shipment, the
-- ordered quantities, at the order price. Lines without a price are counted separately.
create or replace function private.sale_amount(p_sale_id uuid)
returns table (amount numeric, unpriced_lines integer)
language sql stable security definer set search_path = '' as $$
  with shipped as (
    select room.sale_item_id, sum(room.shipped) as quantity from private.customer_return_room(p_sale_id) room group by room.sale_item_id
  )
  select coalesce(round(sum(coalesce(sh.quantity, i.quantity) * i.unit_price), 2), 0),
         count(*) filter (where i.unit_price is null)::integer
  from public.sale_items i
  left join shipped sh on sh.sale_item_id = i.id
  where i.sale_id = p_sale_id
$$;

-- All entries of a customer in every currency. Positive amounts are debts, negative ones reduce the debt.
create or replace function private.customer_ledger(p_customer_id uuid)
returns table (entry_date date, due_date date, kind text, ref_id uuid, ref_number text, currency_id uuid, amount numeric, description text)
language sql stable security definer set search_path = '' as $$
  with opening as (
    select ob.* from public.customer_opening_balances ob where ob.customer_id = p_customer_id and ob.superseded_at is null
  ), deferral as (
    select coalesce((select t.default_deferral_days from public.customer_credit_terms t where t.customer_id = p_customer_id), 0) as days
  ), shipped as (
    select s.id, s.sale_number, coalesce((s.shipped_at at time zone 'Asia/Almaty')::date, s.planned_shipment_date) as ship_date
    from public.sales s where s.customer_id = p_customer_id and s.status = 'shipped'
  ), entries as (
    select o.as_of as entry_date, coalesce(o.due_date, o.as_of + (select days from deferral)) as due_date, 'opening'::text as kind,
           o.id as ref_id, o.contract_number as ref_number, o.currency_id, o.amount,
           'Сальдо по данным 1С на ' || to_char(o.as_of, 'DD.MM.YYYY') as description
    from opening o
    union all
    select sh.ship_date, sh.ship_date + private.sale_deferral_days(sh.id, sh.ship_date), 'shipment', sh.id, sh.sale_number,
           private.sale_currency(sh.id), a.amount,
           'Отгрузка по заказу ' || sh.sale_number || case when a.unpriced_lines > 0 then ' (строк без цены: ' || a.unpriced_lines || ')' else '' end
    from shipped sh cross join lateral private.sale_amount(sh.id) a
    union all
    select (cr.received_at at time zone 'Asia/Almaty')::date, (cr.received_at at time zone 'Asia/Almaty')::date, 'return', cr.id,
           cr.return_number, private.sale_currency(cr.sale_id), -round(sum(ri.quantity * ri.unit_price), 2),
           'Возврат ' || cr.return_number || ' по заказу ' || s.sale_number
    from public.customer_returns cr
    join public.sales s on s.id = cr.sale_id
    join public.customer_return_items ri on ri.return_id = cr.id and ri.unit_price is not null
    where cr.customer_id = p_customer_id and cr.status <> 'cancelled'
    group by cr.id, cr.received_at, cr.return_number, cr.sale_id, s.sale_number
    union all
    select l.doc_date, l.doc_date, 'payment', l.id, l.doc_number, l.currency_id, -l.amount,
           'Оплата' || coalesce(' п/п №' || l.doc_number, '') || coalesce(' · ' || left(l.purpose, 120), '')
    from public.bank_statement_lines l where l.customer_id = p_customer_id and l.status = 'matched'
    union all
    select a.entry_date, a.entry_date, 'adjustment', a.id, null, a.currency_id, a.amount, 'Корректировка: ' || a.reason
    from public.customer_balance_adjustments a where a.customer_id = p_customer_id
  )
  select e.entry_date, e.due_date, e.kind, e.ref_id, e.ref_number, e.currency_id, e.amount, e.description
  from entries e
  left join opening o on o.currency_id = e.currency_id
  where (e.amount <> 0 or e.kind = 'shipment') and (e.kind = 'opening' or o.as_of is null or e.entry_date > o.as_of)
$$;

-- Balance and ageing per currency on a date. Debts are closed by credits oldest due date first.
create or replace function private.customer_aging(p_customer_id uuid, p_today date)
returns table (currency_id uuid, balance numeric, not_due numeric, overdue numeric, overdue_1_30 numeric, overdue_31_60 numeric,
               overdue_61_90 numeric, overdue_over_90 numeric, max_days_overdue integer, oldest_due date)
language sql stable security definer set search_path = '' as $$
  with l as (
    select * from private.customer_ledger(p_customer_id) where entry_date <= p_today
  ), credits as (
    select l.currency_id, -sum(l.amount) as total from l where l.amount < 0 group by l.currency_id
  ), debts as (
    select l.currency_id, l.due_date, l.amount,
           sum(l.amount) over (partition by l.currency_id order by l.due_date, l.entry_date, l.ref_id rows unbounded preceding) as running
    from l where l.amount > 0
  ), open_debts as (
    select d.currency_id, d.due_date, greatest(0, least(d.amount, d.running - coalesce(c.total, 0))) as open_amount
    from debts d left join credits c on c.currency_id = d.currency_id
  ), balances as (
    select l.currency_id, sum(l.amount) as balance from l group by l.currency_id
  )
  select b.currency_id, b.balance,
         coalesce(sum(o.open_amount) filter (where o.due_date >= p_today), 0),
         coalesce(sum(o.open_amount) filter (where o.due_date < p_today), 0),
         coalesce(sum(o.open_amount) filter (where p_today - o.due_date between 1 and 30), 0),
         coalesce(sum(o.open_amount) filter (where p_today - o.due_date between 31 and 60), 0),
         coalesce(sum(o.open_amount) filter (where p_today - o.due_date between 61 and 90), 0),
         coalesce(sum(o.open_amount) filter (where p_today - o.due_date > 90), 0),
         max(p_today - o.due_date) filter (where o.open_amount > 0 and o.due_date < p_today),
         min(o.due_date) filter (where o.open_amount > 0)
  from balances b left join open_debts o on o.currency_id = b.currency_id
  group by b.currency_id, b.balance
$$;

create or replace function private.aging_json(p_customer_id uuid, p_today date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'currency', private.currency_code(a.currency_id), 'balance', a.balance, 'not_due', a.not_due, 'overdue', a.overdue,
    'overdue_1_30', a.overdue_1_30, 'overdue_31_60', a.overdue_31_60, 'overdue_61_90', a.overdue_61_90,
    'overdue_over_90', a.overdue_over_90, 'max_days_overdue', a.max_days_overdue, 'oldest_due', a.oldest_due)
    order by private.currency_code(a.currency_id)), '[]'::jsonb)
  from private.customer_aging(p_customer_id, p_today) a
$$;

-- What should make an employee stop and think before confirming an order.
create or replace function private.sale_credit_issues(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.sales%rowtype; t public.customer_credit_terms%rowtype; v_issues jsonb := '[]'::jsonb; a record;
  v_currency uuid; v_order numeric; v_balance numeric := 0; v_today date := private.receivables_today();
begin
  select * into s from public.sales where id = p_sale_id;
  if not found then return v_issues; end if;
  for a in select * from private.customer_aging(s.customer_id, v_today) where overdue > 0 order by private.currency_code(currency_id) loop
    v_issues := v_issues || jsonb_build_object('code', 'overdue', 'currency', private.currency_code(a.currency_id),
      'amount', a.overdue, 'days', a.max_days_overdue,
      'message', format('Просроченная задолженность %s %s, самая старая — %s дн.', private.money_text(a.overdue), private.currency_code(a.currency_id), a.max_days_overdue));
  end loop;
  select * into t from public.customer_credit_terms where customer_id = s.customer_id;
  if found and t.credit_limit is not null then
    v_currency := private.sale_currency(s.id);
    select amount into v_order from private.sale_amount(s.id);
    select coalesce(sum(balance), 0) into v_balance from private.customer_aging(s.customer_id, v_today) where currency_id = t.limit_currency_id;
    if v_currency = t.limit_currency_id and v_balance + v_order > t.credit_limit then
      v_issues := v_issues || jsonb_build_object('code', 'limit', 'currency', private.currency_code(t.limit_currency_id),
        'amount', v_balance + v_order, 'limit', t.credit_limit,
        'message', format('Долг с этим заказом %s %s превысит кредитный лимит %s', private.money_text(v_balance + v_order),
                          private.currency_code(t.limit_currency_id), private.money_text(t.credit_limit)));
    elsif v_currency <> t.limit_currency_id and v_balance > t.credit_limit then
      v_issues := v_issues || jsonb_build_object('code', 'limit', 'currency', private.currency_code(t.limit_currency_id),
        'amount', v_balance, 'limit', t.credit_limit,
        'message', format('Долг %s %s уже выше кредитного лимита %s', private.money_text(v_balance),
                          private.currency_code(t.limit_currency_id), private.money_text(t.credit_limit)));
    end if;
  end if;
  return v_issues;
end $$;

create or replace function private.sales_receivables_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_issues jsonb;
begin
  if new.status = 'shipped' and old.status is distinct from 'shipped' and new.shipped_at is null then
    new.shipped_at := now();
  end if;
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    v_issues := private.sale_credit_issues(new.id);
    if jsonb_array_length(v_issues) > 0 and not exists (select 1 from public.sale_credit_decisions d where d.sale_id = new.id) then
      raise exception 'У покупателя есть риск по оплате: %. Решите в блоке «Дебиторка» заказа: отложить заказ или продолжить с указанием причины',
        (select string_agg(i ->> 'message', '; ') from jsonb_array_elements(v_issues) i)
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists sales_receivables_guard on public.sales;
create trigger sales_receivables_guard before update of status on public.sales
  for each row execute function private.sales_receivables_guard();

-- ---------- Reading ----------

create or replace function public.customer_receivables()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.receivables_today();
begin
  if not (select private.has_permission('receivables.view')) then
    raise exception 'Нет доступа к дебиторской задолженности' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'customer_id', c.id, 'customer', coalesce(c.short_name, c.legal_name), 'tax_id', c.tax_id,
      'credit_limit', t.credit_limit, 'limit_currency', private.currency_code(t.limit_currency_id),
      'deferral_days', t.default_deferral_days, 'aging', private.aging_json(c.id, v_today),
      'last_act', (select jsonb_build_object('as_of', ra.as_of, 'difference', ra.act_balance - ra.nexus_balance,
                                             'currency', private.currency_code(ra.currency_id))
                   from public.customer_reconciliation_acts ra where ra.customer_id = c.id order by ra.as_of desc, ra.created_at desc limit 1))
      order by coalesce(c.short_name, c.legal_name))
    from public.counterparties c
    left join public.customer_credit_terms t on t.customer_id = c.id
    where 'customer' = any(c.roles) and exists (select 1 from private.customer_ledger(c.id))), '[]'::jsonb);
end $$;

create or replace function public.customer_statement(p_customer_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.receivables_today(); c public.counterparties%rowtype; t public.customer_credit_terms%rowtype;
begin
  if not (select private.has_permission('receivables.view')) then
    raise exception 'Нет доступа к дебиторской задолженности' using errcode = '42501';
  end if;
  select * into c from public.counterparties where id = p_customer_id;
  if not found then raise exception 'Контрагент не найден'; end if;
  select * into t from public.customer_credit_terms where customer_id = p_customer_id;
  return jsonb_build_object(
    'customer_id', c.id, 'customer', coalesce(c.short_name, c.legal_name), 'legal_name', c.legal_name, 'tax_id', c.tax_id,
    'credit_limit', t.credit_limit, 'limit_currency', private.currency_code(t.limit_currency_id), 'deferral_days', t.default_deferral_days,
    'today', v_today, 'aging', private.aging_json(c.id, v_today),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('entry_date', e.entry_date, 'due_date', e.due_date, 'kind', e.kind, 'ref_id', e.ref_id,
        'ref_number', e.ref_number, 'currency', private.currency_code(e.currency_id), 'amount', e.amount, 'description', e.description,
        'running', e.running) order by e.entry_date, e.kind <> 'opening', e.ref_id)
      from (select l.*, sum(l.amount) over (partition by l.currency_id order by l.entry_date, l.kind <> 'opening', l.ref_id
                                            rows unbounded preceding) as running
            from private.customer_ledger(c.id) l) e), '[]'::jsonb),
    'acts', coalesce((
      select jsonb_agg(jsonb_build_object('id', ra.id, 'as_of', ra.as_of, 'currency', private.currency_code(ra.currency_id),
        'act_balance', ra.act_balance, 'nexus_balance', ra.nexus_balance, 'difference', ra.act_balance - ra.nexus_balance, 'note', ra.note)
        order by ra.as_of desc, ra.created_at desc)
      from public.customer_reconciliation_acts ra where ra.customer_id = c.id), '[]'::jsonb));
end $$;

create or replace function public.customer_credit_check(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.sales%rowtype;
begin
  if not ((select private.has_permission('sales.view')) or (select private.has_permission('receivables.view'))) then
    raise exception 'Нет доступа к заказу' using errcode = '42501';
  end if;
  select * into s from public.sales where id = p_sale_id;
  if not found then raise exception 'Заказ не найден'; end if;
  return jsonb_build_object(
    'issues', private.sale_credit_issues(s.id),
    'aging', private.aging_json(s.customer_id, private.receivables_today()),
    'order_amount', (select amount from private.sale_amount(s.id)), 'order_currency', private.currency_code(private.sale_currency(s.id)),
    'decisions', coalesce((
      select jsonb_agg(jsonb_build_object('reason', d.reason, 'decided_at', d.decided_at, 'decided_by', p.full_name, 'issues', d.issues)
        order by d.decided_at desc)
      from public.sale_credit_decisions d left join public.profiles p on p.id = d.decided_by where d.sale_id = s.id), '[]'::jsonb));
end $$;

-- ---------- Decisions and bookkeeping ----------

create or replace function public.record_sale_credit_decision(p_sale_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.sales%rowtype; v_issues jsonb; v_id uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_user record;
begin
  if not (select private.has_permission('sales.manage')) then
    raise exception 'Нет права подтверждать клиентские заказы' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'Укажите, почему заказ продолжается несмотря на риск'; end if;
  if length(v_reason) > 500 then raise exception 'Причина не должна быть длиннее 500 символов'; end if;
  select * into s from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Заказ не найден'; end if;
  if s.status not in ('draft', 'reserved') then raise exception 'Решение принимается до подтверждения заказа'; end if;
  v_issues := private.sale_credit_issues(s.id);
  if jsonb_array_length(v_issues) = 0 then raise exception 'По покупателю нет просрочки и превышения лимита — решение не требуется'; end if;
  insert into public.sale_credit_decisions(sale_id, reason, issues) values (s.id, v_reason, v_issues) returning id into v_id;
  for v_user in
    select p.id from public.profiles p
    where p.id is distinct from auth.uid() and private.user_has_permission(p.id, 'receivables.manage')
  loop
    perform private.notify(v_user.id, 'system', 'Заказ ' || s.sale_number || ' продолжен несмотря на риск по оплате',
      (select string_agg(i ->> 'message', '; ') from jsonb_array_elements(v_issues) i) || '. Причина: ' || v_reason,
      'sale', s.id, null, 'sale_credit_decision:' || v_id);
  end loop;
  return v_id;
end $$;

create or replace function public.set_customer_credit_terms(p_customer_id uuid, p_credit_limit numeric, p_limit_currency text, p_default_deferral_days integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v_currency uuid;
begin
  if not (select private.has_permission('receivables.manage')) then
    raise exception 'Нет права вести дебиторскую задолженность' using errcode = '42501';
  end if;
  if not exists (select 1 from public.counterparties where id = p_customer_id and 'customer' = any(roles)) then
    raise exception 'Покупатель не найден';
  end if;
  if p_credit_limit is not null and p_credit_limit < 0 then raise exception 'Лимит не может быть отрицательным'; end if;
  if p_default_deferral_days is not null and p_default_deferral_days not between 0 and 365 then
    raise exception 'Отсрочка — от 0 до 365 дней';
  end if;
  if p_credit_limit is not null then
    if nullif(btrim(coalesce(p_limit_currency, '')), '') is null then raise exception 'Укажите валюту кредитного лимита'; end if;
    v_currency := private.currency_by_code(p_limit_currency);
  end if;
  insert into public.customer_credit_terms(customer_id, credit_limit, limit_currency_id, default_deferral_days, updated_by, updated_at)
  values (p_customer_id, round(p_credit_limit, 2), v_currency, p_default_deferral_days, auth.uid(), now())
  on conflict (customer_id) do update set credit_limit = excluded.credit_limit, limit_currency_id = excluded.limit_currency_id,
    default_deferral_days = excluded.default_deferral_days, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;

-- Finds the customer of a row from a 1С report or a statement: by BIN, else by an exact name.
create or replace function private.find_customer(p_bin text, p_name text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_bin text := nullif(regexp_replace(coalesce(p_bin, ''), '\D', '', 'g'), ''); v_name text := lower(btrim(coalesce(p_name, ''))); v_ids uuid[];
begin
  if v_bin is not null then
    select array_agg(id) into v_ids from public.counterparties
    where 'customer' = any(roles) and status <> 'archived' and regexp_replace(coalesce(tax_id, ''), '\D', '', 'g') = v_bin;
    if cardinality(v_ids) = 1 then return v_ids[1]; end if;
  end if;
  if v_name <> '' then
    select array_agg(id) into v_ids from public.counterparties
    where 'customer' = any(roles) and status <> 'archived' and (lower(btrim(legal_name)) = v_name or lower(btrim(short_name)) = v_name);
    if cardinality(v_ids) = 1 then return v_ids[1]; end if;
  end if;
  return null;
end $$;

-- Rows: [{customer_id?, bin?, name?, currency?, amount, contract?, due_date?}]. Amount > 0 — the customer owes us,
-- < 0 — an advance. Each applied row replaces the active opening balance of that customer and currency.
create or replace function public.import_opening_balances(p_as_of date, p_rows jsonb, p_file_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb; v_customer uuid; v_currency uuid; v_amount numeric; v_due date; v_new uuid; v_old uuid; v_n integer := 0;
  v_applied integer := 0; v_unmatched jsonb := '[]'::jsonb; v_seen text[] := '{}';
begin
  if not (select private.has_permission('receivables.manage')) then
    raise exception 'Нет права вести дебиторскую задолженность' using errcode = '42501';
  end if;
  if p_as_of is null or p_as_of > private.receivables_today() then raise exception 'Дата сальдо не может быть в будущем'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'В отчёте нет строк'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'В одном отчёте допускается не более 2000 строк'; end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_row -> 'amount') <> 'number' then raise exception 'Строка %: сумма должна быть числом', v_n; end if;
    v_amount := round((v_row ->> 'amount')::numeric, 2);
    v_currency := private.currency_by_code(coalesce(nullif(v_row ->> 'currency', ''), 'KZT'));
    begin v_due := nullif(v_row ->> 'due_date', '')::date; exception when others then raise exception 'Строка %: некорректный срок оплаты', v_n; end;
    if nullif(v_row ->> 'customer_id', '') is not null then
      begin v_customer := (v_row ->> 'customer_id')::uuid; exception when others then raise exception 'Строка %: некорректный покупатель', v_n; end;
      if not exists (select 1 from public.counterparties where id = v_customer and 'customer' = any(roles)) then
        raise exception 'Строка %: покупатель не найден', v_n;
      end if;
    else
      v_customer := private.find_customer(v_row ->> 'bin', v_row ->> 'name');
    end if;
    if v_customer is null then
      v_unmatched := v_unmatched || jsonb_build_object('row', v_n, 'bin', v_row ->> 'bin', 'name', v_row ->> 'name', 'amount', v_amount,
                                                       'currency', private.currency_code(v_currency));
      continue;
    end if;
    -- One balance per customer and currency: several contracts of one customer in the report are summed.
    if (v_customer || ':' || v_currency) = any(v_seen) then
      update public.customer_opening_balances set amount = amount + v_amount,
        contract_number = left(concat_ws(', ', contract_number, nullif(btrim(v_row ->> 'contract'), '')), 200),
        due_date = case when v_due is null then due_date when due_date is null then v_due else least(due_date, v_due) end
      where customer_id = v_customer and currency_id = v_currency and superseded_at is null;
    else
      v_seen := v_seen || (v_customer || ':' || v_currency);
      select id into v_old from public.customer_opening_balances
      where customer_id = v_customer and currency_id = v_currency and superseded_at is null for update;
      update public.customer_opening_balances set superseded_at = now() where id = v_old;
      insert into public.customer_opening_balances(customer_id, currency_id, as_of, amount, due_date, contract_number, source_file_name)
      values (v_customer, v_currency, p_as_of, v_amount, v_due, left(nullif(btrim(v_row ->> 'contract'), ''), 200), left(p_file_name, 255))
      returning id into v_new;
      update public.customer_opening_balances set superseded_by = v_new where id = v_old;
    end if;
    v_applied := v_applied + 1;
  end loop;
  return jsonb_build_object('applied', v_applied, 'unmatched', v_unmatched);
end $$;

-- Lines: [{doc_number, doc_date, amount, payer_name, payer_bin, payer_account, purpose}] — incoming payments only.
-- A statement already loaded (same file) is refused; a payment already loaded from an overlapping statement is skipped.
create or replace function public.import_bank_statement(p_file_name text, p_file_sha256 text, p_account text, p_period_from date,
                                                        p_period_to date, p_currency text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_import uuid; v_currency uuid := private.currency_by_code(coalesce(nullif(p_currency, ''), 'KZT')); v_line jsonb; v_n integer := 0;
  v_new integer := 0; v_matched integer := 0; v_date date; v_amount numeric; v_key text; v_customer uuid; v_sale_id uuid; v_sale_customer uuid; v_how text;
  v_order text; v_line_id uuid;
begin
  if not (select private.has_permission('receivables.manage')) then
    raise exception 'Нет права вести дебиторскую задолженность' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_file_name, '')), '') is null then raise exception 'Не указано имя файла'; end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Некорректная контрольная сумма файла'; end if;
  if exists (select 1 from public.bank_statement_imports where file_sha256 = p_file_sha256) then
    raise exception 'Эта выписка уже загружена';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'Некорректный список платежей'; end if;
  if jsonb_array_length(p_lines) > 5000 then raise exception 'В одной выписке допускается не более 5000 платежей'; end if;
  insert into public.bank_statement_imports(file_name, file_sha256, account_number, period_from, period_to, currency_id)
  values (left(btrim(p_file_name), 255), p_file_sha256, left(nullif(btrim(p_account), ''), 64), p_period_from, p_period_to, v_currency)
  returning id into v_import;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    begin v_date := (v_line ->> 'doc_date')::date; exception when others then raise exception 'Платёж %: некорректная дата', v_n; end;
    if v_date is null then raise exception 'Платёж %: нет даты', v_n; end if;
    if jsonb_typeof(v_line -> 'amount') <> 'number' then raise exception 'Платёж %: сумма должна быть числом', v_n; end if;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    if v_amount <= 0 then raise exception 'Платёж %: сумма должна быть больше нуля', v_n; end if;
    v_key := encode(sha256(convert_to(concat_ws('|', coalesce(p_account, ''), btrim(coalesce(v_line ->> 'doc_number', '')), v_date::text,
                    v_amount::text, regexp_replace(coalesce(v_line ->> 'payer_bin', ''), '\D', '', 'g'),
                    btrim(coalesce(v_line ->> 'payer_account', '')), btrim(coalesce(v_line ->> 'purpose', ''))), 'UTF8')), 'hex');
    continue when exists (select 1 from public.bank_statement_lines where line_key = v_key);

    v_customer := private.find_customer(v_line ->> 'payer_bin', null);
    v_how := case when v_customer is not null then 'auto_bin' end;
    v_order := substring(coalesce(v_line ->> 'purpose', '') from '(?i)SO-\d{4}-\d{6}');
    v_sale_id := null; v_sale_customer := null;
    if v_order is not null then
      select s.id, s.customer_id into v_sale_id, v_sale_customer from public.sales s where s.sale_number = upper(v_order) and s.status <> 'cancelled';
      if v_sale_id is not null and v_customer is null then
        v_customer := v_sale_customer; v_how := 'auto_order';
      elsif v_sale_id is not null and v_sale_customer <> v_customer then
        v_sale_id := null;
      end if;
    end if;
    insert into public.bank_statement_lines(import_id, line_key, doc_number, doc_date, amount, currency_id, payer_name, payer_bin,
      payer_account, purpose, status, customer_id, sale_id, matched_how, resolved_at)
    values (v_import, v_key, left(nullif(btrim(v_line ->> 'doc_number'), ''), 64), v_date, v_amount, v_currency,
      left(nullif(btrim(v_line ->> 'payer_name'), ''), 500), left(nullif(regexp_replace(coalesce(v_line ->> 'payer_bin', ''), '\D', '', 'g'), ''), 32),
      left(nullif(btrim(v_line ->> 'payer_account'), ''), 64), left(nullif(btrim(v_line ->> 'purpose'), ''), 2000),
      case when v_customer is null then 'unmatched' else 'matched' end, v_customer, v_sale_id, v_how,
      case when v_customer is null then null else now() end)
    returning id into v_line_id;
    v_new := v_new + 1;
    if v_customer is not null then v_matched := v_matched + 1; end if;
  end loop;
  update public.bank_statement_imports set lines_total = v_n, lines_new = v_new, lines_matched = v_matched where id = v_import;
  return jsonb_build_object('import_id', v_import, 'total', v_n, 'new', v_new, 'duplicates', v_n - v_new, 'matched', v_matched);
end $$;

-- match: assign the payment to a customer (and optionally an order); ignore: not a customer payment (a refund,
-- a transfer between own accounts), with a note; reset: back to the unresolved list.
create or replace function public.resolve_bank_line(p_line_id uuid, p_action text, p_customer_id uuid default null,
                                                    p_sale_id uuid default null, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare l public.bank_statement_lines%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (select private.has_permission('receivables.manage')) then
    raise exception 'Нет права вести дебиторскую задолженность' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'Комментарий не должен быть длиннее 500 символов'; end if;
  select * into l from public.bank_statement_lines where id = p_line_id for update;
  if not found then raise exception 'Платёж не найден'; end if;
  if p_action = 'match' then
    if not exists (select 1 from public.counterparties where id = p_customer_id and 'customer' = any(roles)) then
      raise exception 'Покупатель не найден';
    end if;
    if p_sale_id is not null and not exists (select 1 from public.sales where id = p_sale_id and customer_id = p_customer_id and status <> 'cancelled') then
      raise exception 'Заказ не относится к этому покупателю';
    end if;
    update public.bank_statement_lines set status = 'matched', customer_id = p_customer_id, sale_id = p_sale_id, matched_how = 'manual',
      note = coalesce(v_note, note), resolved_by = auth.uid(), resolved_at = now() where id = l.id;
  elsif p_action = 'ignore' then
    if v_note is null then raise exception 'Укажите, почему платёж не относится к покупателям'; end if;
    update public.bank_statement_lines set status = 'ignored', customer_id = null, sale_id = null, matched_how = null, note = v_note,
      resolved_by = auth.uid(), resolved_at = now() where id = l.id;
  elsif p_action = 'reset' then
    update public.bank_statement_lines set status = 'unmatched', customer_id = null, sale_id = null, matched_how = null,
      note = coalesce(v_note, note), resolved_by = auth.uid(), resolved_at = now() where id = l.id;
  else
    raise exception 'Некорректное действие с платежом';
  end if;
end $$;

create or replace function public.add_customer_balance_adjustment(p_customer_id uuid, p_currency text, p_entry_date date, p_amount numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not (select private.has_permission('receivables.manage')) then
    raise exception 'Нет права вести дебиторскую задолженность' using errcode = '42501';
  end if;
  if not exists (select 1 from public.counterparties where id = p_customer_id and 'customer' = any(roles)) then
    raise exception 'Покупатель не найден';
  end if;
  if p_amount is null or round(p_amount, 2) = 0 then raise exception 'Сумма корректировки не может быть нулевой'; end if;
  if v_reason is null or length(v_reason) > 500 then raise exception 'Укажите причину корректировки (до 500 символов)'; end if;
  if p_entry_date is null or p_entry_date > private.receivables_today() then raise exception 'Дата корректировки не может быть в будущем'; end if;
  insert into public.customer_balance_adjustments(customer_id, currency_id, entry_date, amount, reason)
  values (p_customer_id, private.currency_by_code(p_currency), p_entry_date, round(p_amount, 2), v_reason) returning id into v_id;
  return v_id;
end $$;

-- A signed reconciliation act: its balance next to the Nexus balance on the same date. A difference is shown,
-- never corrected automatically.
create or replace function public.record_reconciliation_act(p_customer_id uuid, p_currency text, p_as_of date, p_act_balance numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_currency uuid := private.currency_by_code(p_currency); v_nexus numeric; v_id uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (select private.has_permission('receivables.manage')) then
    raise exception 'Нет права вести дебиторскую задолженность' using errcode = '42501';
  end if;
  if not exists (select 1 from public.counterparties where id = p_customer_id and 'customer' = any(roles)) then
    raise exception 'Покупатель не найден';
  end if;
  if p_as_of is null or p_as_of > private.receivables_today() then raise exception 'Дата акта не может быть в будущем'; end if;
  if p_act_balance is null then raise exception 'Укажите сальдо по акту'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'Комментарий не должен быть длиннее 500 символов'; end if;
  select coalesce(sum(amount), 0) into v_nexus from private.customer_ledger(p_customer_id) where currency_id = v_currency and entry_date <= p_as_of;
  insert into public.customer_reconciliation_acts(customer_id, currency_id, as_of, act_balance, nexus_balance, note)
  values (p_customer_id, v_currency, p_as_of, round(p_act_balance, 2), v_nexus, v_note) returning id into v_id;
  return jsonb_build_object('id', v_id, 'nexus_balance', v_nexus, 'difference', round(p_act_balance, 2) - v_nexus);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'private.receivables_today()', 'private.money_text(numeric)', 'private.currency_code(uuid)', 'private.currency_by_code(text)', 'private.sale_currency(uuid)',
    'private.sale_deferral_days(uuid,date)', 'private.sale_amount(uuid)', 'private.customer_ledger(uuid)',
    'private.customer_aging(uuid,date)', 'private.aging_json(uuid,date)', 'private.sale_credit_issues(uuid)',
    'private.sales_receivables_guard()', 'private.find_customer(text,text)',
    'public.customer_receivables()', 'public.customer_statement(uuid)', 'public.customer_credit_check(uuid)',
    'public.record_sale_credit_decision(uuid,text)', 'public.set_customer_credit_terms(uuid,numeric,text,integer)',
    'public.import_opening_balances(date,jsonb,text)', 'public.import_bank_statement(text,text,text,date,date,text,jsonb)',
    'public.resolve_bank_line(uuid,text,uuid,uuid,text)', 'public.add_customer_balance_adjustment(uuid,text,date,numeric,text)',
    'public.record_reconciliation_act(uuid,text,date,numeric,text)'
  ] loop execute format('revoke all on function %s from public, anon, authenticated, service_role', f); end loop;
end $$;
grant execute on function public.customer_receivables(), public.customer_statement(uuid), public.customer_credit_check(uuid),
  public.record_sale_credit_decision(uuid,text), public.set_customer_credit_terms(uuid,numeric,text,integer),
  public.import_opening_balances(date,jsonb,text), public.import_bank_statement(text,text,text,date,date,text,jsonb),
  public.resolve_bank_line(uuid,text,uuid,uuid,text), public.add_customer_balance_adjustment(uuid,text,date,numeric,text),
  public.record_reconciliation_act(uuid,text,date,numeric,text) to authenticated;
