-- Advances to suppliers and carriers (follow-up of block 2, 202611170400). Owner decision of 2026-11-16
-- (damirator1-afk): a payment made before the expense exists in Nexus belongs to the payee and is later set off
-- against the expense. The structure of 202611170400 is used as prepared: an advance is a payment
-- (kind = 'advance') without applications yet; setting it off adds an application to the expense.
--   * an advance is in one currency and is set off only against expenses of the same payee in that currency;
--   * an advance for goods is visible and usable only with prices.purchase.view, like goods cost;
--   * the remainder of an advance is shown in the register next to the debt; the sums are never netted silently;
--   * history is append-only as for every payment; the cost of goods does not depend on advances.
begin;

alter table public.payments
  add column if not exists kind text not null default 'payment',
  add column if not exists advance_for text;
do $$begin
  if not exists (select 1 from pg_constraint where conname = 'payments_kind_check') then
    alter table public.payments add constraint payments_kind_check check (kind in ('payment', 'advance'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_advance_check') then
    alter table public.payments add constraint payments_advance_check check (
      (kind = 'advance') = (advance_for is not null) and (advance_for is null or advance_for in ('goods', 'services'))
      and (kind <> 'advance' or payee_counterparty_id is not null));
  end if;
end $$;
alter table public.payment_applications add column if not exists request_id uuid unique;
create index if not exists payments_open_advances_idx on public.payments(payee_counterparty_id, currency_id) where kind = 'advance';

create or replace function private.payment_unapplied(p_payment_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select p.amount - coalesce((select sum(a.amount) from public.payment_applications a where a.payment_id = p.id), 0)
    from public.payments p where p.id = p_payment_id
$$;
revoke all on function private.payment_unapplied(uuid) from public, anon, authenticated, service_role;

-- 202611170400 check, with the payment row locked too: two set-offs of one advance at the same time cannot
-- together exceed it (the expense row was already locked against overpaying the expense).
create or replace function private.check_payment_application() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  e public.expenses;
  p public.payments;
begin
  select * into p from public.payments where id = new.payment_id for update;
  select * into e from public.expenses where id = new.expense_id for update;
  if e.id is null or p.id is null then raise exception 'Расход или оплата не найдены'; end if;
  if p.currency_id <> e.currency_id then raise exception 'Оплата должна быть в валюте расхода'; end if;
  if p.payee_counterparty_id is distinct from e.payee_counterparty_id then raise exception 'Оплата относится к другому получателю'; end if;
  if not p.legacy and (e.is_planned or e.status not in ('confirmed', 'allocated')) then
    raise exception 'Оплатить можно только подтверждённый фактический расход, ещё не оплаченный полностью';
  end if;
  if private.expense_paid_amount(e.id) + new.amount > e.amount then
    raise exception 'Сумма оплат превышает сумму расхода: осталось оплатить %', e.amount - private.expense_paid_amount(e.id);
  end if;
  if (select coalesce(sum(a.amount), 0) from public.payment_applications a where a.payment_id = p.id) + new.amount > p.amount then
    raise exception 'Аванс или оплата уже распределены: остаток %', private.payment_unapplied(p.id);
  end if;
  return new;
end $$;
revoke all on function private.check_payment_application() from public, anon, authenticated, service_role;

-- An advance: a payment to a payee before the expense exists. Repeating the same request returns the same advance.
create or replace function public.record_advance_payment(p_request_id uuid, p_payee_id uuid, p_currency_id uuid, p_amount numeric,
                                                         p_paid_on date, p_advance_for text, p_document_id uuid default null,
                                                         p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_request_id is null then raise exception 'Обновите страницу'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 170400));
  select id into v_id from public.payments where request_id = p_request_id;
  if found then return v_id; end if;
  if not (select private.has_permission('finance.pay')) then raise exception 'Нет права подтверждать оплату' using errcode = '42501'; end if;
  if p_advance_for is null or p_advance_for not in ('goods', 'services') then raise exception 'Укажите, за что аванс: товар или услуги'; end if;
  if p_advance_for = 'goods' and not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к стоимости товара' using errcode = '42501';
  end if;
  if not exists (select 1 from public.counterparties where id = p_payee_id and status = 'active') then raise exception 'Получатель не найден'; end if;
  if not exists (select 1 from public.currencies where id = p_currency_id) then raise exception 'Укажите валюту'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount, 2) <> p_amount then raise exception 'Укажите сумму аванса больше нуля, до копеек'; end if;
  if p_paid_on is null or p_paid_on > private.business_today() then raise exception 'Дата оплаты не может быть в будущем'; end if;
  if p_document_id is not null and not exists (select 1 from public.documents where id = p_document_id and archived_at is null) then
    raise exception 'Документ-основание не найден';
  end if;
  insert into public.payments(payee_counterparty_id, currency_id, amount, paid_on, document_id, note, request_id, created_by, kind, advance_for)
  values (p_payee_id, p_currency_id, p_amount, p_paid_on, p_document_id, nullif(btrim(coalesce(p_note, '')), ''), p_request_id, auth.uid(),
          'advance', p_advance_for)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.record_advance_payment(uuid, uuid, uuid, numeric, date, text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.record_advance_payment(uuid, uuid, uuid, numeric, date, text, uuid, text) to authenticated;

-- Setting an advance off against an expense of the same payee and currency: an application, as a payment would be.
create or replace function public.apply_advance(p_request_id uuid, p_payment_id uuid, p_expense_id uuid, p_amount numeric)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p public.payments;
  e public.expenses;
  v_id uuid;
begin
  if p_request_id is null then raise exception 'Обновите страницу'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 170700));
  select id into v_id from public.payment_applications where request_id = p_request_id;
  if found then return v_id; end if;
  if not (select private.has_permission('finance.pay')) then raise exception 'Нет права подтверждать оплату' using errcode = '42501'; end if;
  select * into p from public.payments where id = p_payment_id and kind = 'advance' for update;
  if not found then raise exception 'Аванс не найден'; end if;
  select * into e from public.expenses where id = p_expense_id for update;
  if not found then raise exception 'Расход не найден'; end if;
  if (p.advance_for = 'goods' or e.expense_type = 'goods_cost') and not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к стоимости товара' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or round(p_amount, 2) <> p_amount then raise exception 'Укажите сумму зачёта больше нуля, до копеек'; end if;
  insert into public.payment_applications(payment_id, expense_id, amount, created_by, request_id)
  values (p.id, e.id, p_amount, auth.uid(), p_request_id) returning id into v_id;
  if private.expense_paid_amount(e.id) >= e.amount and e.status = 'allocated' then
    update public.expenses set status = 'paid', paid_by = auth.uid(), paid_at = now(), updated_at = now() where id = e.id;
  end if;
  return v_id;
end $$;
revoke all on function public.apply_advance(uuid, uuid, uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.apply_advance(uuid, uuid, uuid, numeric) to authenticated;

-- Advances with a remainder that the caller may see (goods only with purchase prices).
create or replace function private.open_advances()
returns table(payment_id uuid, payee_id uuid, currency_id uuid, amount numeric, remaining numeric, paid_on date,
              advance_for text, note text, created_by uuid)
language sql stable security definer set search_path = '' as $$
  select p.id, p.payee_counterparty_id, p.currency_id, p.amount, private.payment_unapplied(p.id), p.paid_on, p.advance_for, p.note, p.created_by
    from public.payments p
   where p.kind = 'advance' and private.payment_unapplied(p.id) > 0
     and (p.advance_for <> 'goods' or (select private.has_permission('prices.purchase.view')))
$$;
revoke all on function private.open_advances() from public, anon, authenticated, service_role;

-- Register of 202611170400 with the open advances next to the debt (never netted): payees with only an advance too.
create or replace function public.payables_summary()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.business_today();
begin
  if not (select private.has_permission('finance.view')) then raise exception 'Нет доступа к кредиторке' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'payee_id', k.payee_id, 'payee', coalesce(c.short_name, c.legal_name), 'currency', cur.code,
            'accrued', coalesce(x.accrued, 0)::text, 'paid', coalesce(x.paid, 0)::text, 'rest', (coalesce(x.accrued, 0) - coalesce(x.paid, 0))::text,
            'advances', coalesce(a.remaining, 0)::text,
            'open_expenses', coalesce(x.open_count, 0), 'no_due_date', coalesce(x.no_due, 0), 'nearest_due', x.nearest_due,
            'overdue_amount', coalesce(x.overdue_amount, 0)::text, 'overdue_days', x.overdue_days)
            order by (x.overdue_days is null), x.overdue_days desc, coalesce(c.short_name, c.legal_name), cur.code), '[]'::jsonb)
    from (select p.payee_id, p.currency_id from private.payable_expenses() p
          union select o.payee_id, o.currency_id from private.open_advances() o) k
    left join (select p.payee_id, p.currency_id, sum(p.amount) as accrued, sum(p.paid) as paid,
                 count(*) filter (where p.amount > p.paid) as open_count,
                 count(*) filter (where p.amount > p.paid and p.due_date is null) as no_due,
                 min(p.due_date) filter (where p.amount > p.paid and p.due_date >= v_today) as nearest_due,
                 coalesce(sum(p.amount - p.paid) filter (where p.amount > p.paid and p.due_date < v_today), 0) as overdue_amount,
                 max(v_today - p.due_date) filter (where p.amount > p.paid and p.due_date < v_today) as overdue_days
            from private.payable_expenses() p group by p.payee_id, p.currency_id) x
      on x.payee_id is not distinct from k.payee_id and x.currency_id = k.currency_id
    left join (select o.payee_id, o.currency_id, sum(o.remaining) as remaining from private.open_advances() o group by o.payee_id, o.currency_id) a
      on a.payee_id is not distinct from k.payee_id and a.currency_id = k.currency_id
    left join public.counterparties c on c.id = k.payee_id
    join public.currencies cur on cur.id = k.currency_id);
end $$;
revoke all on function public.payables_summary() from public, anon, authenticated, service_role;
grant execute on function public.payables_summary() to authenticated;

-- Payee card of 202611170400 plus the advances: amount, remainder, and where each was set off.
create or replace function public.payables_payee(p_payee_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.business_today();
begin
  if not (select private.has_permission('finance.view')) then raise exception 'Нет доступа к кредиторке' using errcode = '42501'; end if;
  return jsonb_build_object(
    'payee', (select coalesce(short_name, legal_name) from public.counterparties where id = p_payee_id),
    'payment_terms', (select payment_terms from public.carriers where counterparty_id = p_payee_id and p_payee_id is not null limit 1),
    'can_pay', private.has_permission('finance.pay'), 'can_manage', private.has_permission('finance.manage'),
    'can_goods', private.has_permission('prices.purchase.view'),
    'expenses', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.expense_id, 'type', p.expense_type, 'status', p.status, 'currency', cur.code, 'currency_id', p.currency_id,
        'amount', p.amount::text, 'paid', p.paid::text, 'rest', (p.amount - p.paid)::text,
        'incurred_at', p.incurred_at, 'due_date', p.due_date,
        'overdue_days', case when p.amount > p.paid and p.due_date < v_today then v_today - p.due_date end,
        'shipment', s.shipment_number, 'shipment_id', p.shipment_id,
        'payments', (select coalesce(jsonb_agg(jsonb_build_object('amount', a.amount::text, 'paid_on', pay.paid_on,
              'author', pr.full_name, 'document', d.title, 'document_id', pay.document_id, 'note', pay.note,
              'legacy', pay.legacy, 'advance', pay.kind = 'advance', 'created_at', a.created_at) order by pay.paid_on, a.created_at), '[]'::jsonb)
            from public.payment_applications a join public.payments pay on pay.id = a.payment_id
            left join public.profiles pr on pr.id = pay.created_by left join public.documents d on d.id = pay.document_id
           where a.expense_id = p.expense_id))
        order by (p.amount <= p.paid), p.due_date nulls last, p.incurred_at), '[]'::jsonb)
      from private.payable_expenses() p join public.currencies cur on cur.id = p.currency_id
      left join public.shipments s on s.id = p.shipment_id
     where p.payee_id is not distinct from p_payee_id),
    'advances', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'currency', cur.code, 'currency_id', p.currency_id, 'amount', p.amount::text,
        'remaining', private.payment_unapplied(p.id)::text, 'paid_on', p.paid_on, 'advance_for', p.advance_for,
        'note', p.note, 'author', pr.full_name, 'created_at', p.created_at,
        'applications', (select coalesce(jsonb_agg(jsonb_build_object('expense_id', a.expense_id, 'amount', a.amount::text,
              'created_at', a.created_at) order by a.created_at), '[]'::jsonb)
            from public.payment_applications a where a.payment_id = p.id))
        order by (private.payment_unapplied(p.id) = 0), p.paid_on desc, p.created_at desc), '[]'::jsonb)
      from public.payments p join public.currencies cur on cur.id = p.currency_id left join public.profiles pr on pr.id = p.created_by
     where p.kind = 'advance' and p.payee_counterparty_id = p_payee_id
       and (p.advance_for <> 'goods' or (select private.has_permission('prices.purchase.view')))));
end $$;
revoke all on function public.payables_payee(uuid) from public, anon, authenticated, service_role;
grant execute on function public.payables_payee(uuid) to authenticated;
commit;
