-- «Дебиторка»: the ledger of each customer is computed once, not twice (performance measurement 25.11.2026, point 4).
-- customer_receivables (202609277600) checked every customer with `exists (select 1 from customer_ledger(c.id))` and
-- then computed aging_json(c.id), which builds the same ledger again: two full ledgers per customer (sale amounts,
-- returns, deferral and currency of every shipped order). The rules of the ledger and of the aging do not change: the
-- aging body is the same, it now reads the ledger rows it is given, and customer_receivables builds them once.
-- customer_aging(customer, today) and aging_json(customer, today) keep their signatures and results for the statement,
-- the credit check and the assistant.
begin;

do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'private' and t.typname = 'ledger_entry') then
    create type private.ledger_entry as (entry_date date, due_date date, kind text, ref_id uuid, ref_number text, currency_id uuid,
                                         amount numeric, description text);
  end if;
end $$;

-- The body of customer_aging (202609277600), reading the given ledger rows instead of computing them.
create or replace function private.customer_aging_of(p_entries private.ledger_entry[], p_today date)
returns table (currency_id uuid, balance numeric, not_due numeric, overdue numeric, overdue_1_30 numeric, overdue_31_60 numeric,
               overdue_61_90 numeric, overdue_over_90 numeric, max_days_overdue integer, oldest_due date)
language sql stable security definer set search_path = '' as $$
  with l as (
    select * from unnest(p_entries) where entry_date <= p_today
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

create or replace function private.customer_aging(p_customer_id uuid, p_today date)
returns table (currency_id uuid, balance numeric, not_due numeric, overdue numeric, overdue_1_30 numeric, overdue_31_60 numeric,
               overdue_61_90 numeric, overdue_over_90 numeric, max_days_overdue integer, oldest_due date)
language sql stable security definer set search_path = '' as $$
  select * from private.customer_aging_of(
    array(select row(l.*)::private.ledger_entry from private.customer_ledger(p_customer_id) l), p_today)
$$;

-- The body of aging_json (202609277600) over the given ledger rows.
create or replace function private.aging_json_of(p_entries private.ledger_entry[], p_today date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'currency', private.currency_code(a.currency_id), 'balance', a.balance, 'not_due', a.not_due, 'overdue', a.overdue,
    'overdue_1_30', a.overdue_1_30, 'overdue_31_60', a.overdue_31_60, 'overdue_61_90', a.overdue_61_90,
    'overdue_over_90', a.overdue_over_90, 'max_days_overdue', a.max_days_overdue, 'oldest_due', a.oldest_due)
    order by private.currency_code(a.currency_id)), '[]'::jsonb)
  from private.customer_aging_of(p_entries, p_today) a
$$;

create or replace function private.aging_json(p_customer_id uuid, p_today date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.aging_json_of(array(select row(l.*)::private.ledger_entry from private.customer_ledger(p_customer_id) l), p_today)
$$;

-- As in 202609277600, except that each customer's ledger is built once: it decides whether the customer is listed
-- (any ledger row) and feeds the aging.
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
      'deferral_days', t.default_deferral_days, 'aging', private.aging_json_of(led.entries, v_today),
      'last_act', (select jsonb_build_object('as_of', ra.as_of, 'difference', ra.act_balance - ra.nexus_balance,
                                             'currency', private.currency_code(ra.currency_id))
                   from public.customer_reconciliation_acts ra where ra.customer_id = c.id order by ra.as_of desc, ra.created_at desc limit 1))
      order by coalesce(c.short_name, c.legal_name))
    from public.counterparties c
    left join public.customer_credit_terms t on t.customer_id = c.id
    cross join lateral (select array_agg(row(l.*)::private.ledger_entry) as entries from private.customer_ledger(c.id) l) led
    where 'customer' = any(c.roles) and led.entries is not null), '[]'::jsonb);
end $$;

revoke all on function private.customer_aging_of(private.ledger_entry[], date), private.aging_json_of(private.ledger_entry[], date),
  private.customer_aging(uuid, date), private.aging_json(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.customer_receivables() from public, anon, service_role;
grant execute on function public.customer_receivables() to authenticated;

commit;
