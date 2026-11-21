-- Audit of 2026-11-18, finding П7. A partly or fully paid expense can only be reversed, and its payments vanished
-- from the payables register: the money paid out was nowhere. Owner decisions of 2026-11-21 (damirator1-afk):
--   * what was paid against a reversed expense is the payee's debt to us ("переплата"), shown in the register next
--     to the debt and the advances, never netted with them;
--   * it is closed in two ways: a refund from the payee (date, amount, basis document, note), or a set-off against
--     another expense of the same payee in the same currency and of the same kind (goods or services), exactly as
--     an advance is set off (apply_advance);
--   * history is never edited: the applications to the reversed expense stay; the unapplied part of a payment is
--     its amount minus its applications to expenses that are not reversed, minus its refunds.
-- The same refund also returns the unused rest of an advance.
begin;

-- Refunds: money the payee returned. Append-only, like payments.
create table if not exists public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  received_on date not null,
  document_id uuid references public.documents(id) on delete restrict,
  note text check (note is null or length(note) <= 1000),
  request_id uuid not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists payment_refunds_payment_idx on public.payment_refunds(payment_id);
create index if not exists payment_refunds_document_idx on public.payment_refunds(document_id);
create index if not exists payment_refunds_created_by_idx on public.payment_refunds(created_by);
alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from public, anon, authenticated, service_role;
drop trigger if exists payment_refunds_immutable on public.payment_refunds;
create trigger payment_refunds_immutable before update or delete on public.payment_refunds
  for each row execute function private.guard_payment_history();

-- What is still free on a payment: not applied to a living expense and not refunded.
create or replace function private.payment_unapplied(p_payment_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select p.amount
         - coalesce((select sum(a.amount) from public.payment_applications a join public.expenses e on e.id = a.expense_id
                      where a.payment_id = p.id and e.status <> 'reversed'), 0)
         - coalesce((select sum(r.amount) from public.payment_refunds r where r.payment_id = p.id), 0)
    from public.payments p where p.id = p_payment_id
$$;
revoke all on function private.payment_unapplied(uuid) from public, anon, authenticated, service_role;

-- The kind of the money a payment paid against reversed expenses: goods, services, mixed, or null when none.
create or replace function private.payment_released_kind(p_payment_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when count(*) = 0 then null
              when bool_and(e.expense_type = 'goods_cost') then 'goods'
              when bool_or(e.expense_type = 'goods_cost') then 'mixed'
              else 'services' end
    from public.payment_applications a join public.expenses e on e.id = a.expense_id
   where a.payment_id = p_payment_id and e.status = 'reversed'
$$;
revoke all on function private.payment_released_kind(uuid) from public, anon, authenticated, service_role;

create or replace function private.payment_refund_list(p_payment_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('amount', r.amount::text, 'received_on', r.received_on, 'note', r.note,
           'document', d.title, 'document_id', r.document_id, 'author', pr.full_name, 'created_at', r.created_at)
           order by r.received_on, r.created_at), '[]'::jsonb)
    from public.payment_refunds r left join public.documents d on d.id = r.document_id left join public.profiles pr on pr.id = r.created_by
   where r.payment_id = p_payment_id
$$;
revoke all on function private.payment_refund_list(uuid) from public, anon, authenticated, service_role;

-- 202611170700 check with the free part counted as above: an application can use only what is still free.
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
  if new.amount > private.payment_unapplied(p.id) then
    raise exception 'Аванс или оплата уже распределены: остаток %', private.payment_unapplied(p.id);
  end if;
  return new;
end $$;
revoke all on function private.check_payment_application() from public, anon, authenticated, service_role;

-- Overpayments with a remainder that the caller may see (goods only with purchase prices).
create or replace function private.open_overpayments()
returns table(payment_id uuid, payee_id uuid, currency_id uuid, remaining numeric, released_kind text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.payee_counterparty_id, p.currency_id, private.payment_unapplied(p.id), private.payment_released_kind(p.id)
    from public.payments p
   where p.kind = 'payment' and private.payment_released_kind(p.id) is not null and private.payment_unapplied(p.id) > 0
     and (private.payment_released_kind(p.id) = 'services' or (select private.has_permission('prices.purchase.view')))
$$;
revoke all on function private.open_overpayments() from public, anon, authenticated, service_role;

-- A refund from the payee: closes (part of) an overpayment or the unused rest of an advance. Repeating the same
-- request returns the same refund; two refunds at once cannot together exceed what is free.
create or replace function public.record_payment_refund(p_request_id uuid, p_payment_id uuid, p_amount numeric, p_received_on date,
                                                        p_document_id uuid default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p public.payments;
  v_kind text;
  v_id uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_request_id is null then raise exception 'Обновите страницу'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 211200));
  select id into v_id from public.payment_refunds where request_id = p_request_id;
  if found then return v_id; end if;
  if not ((select private.has_permission('finance.manage')) and (select private.has_permission('finance.pay'))) then
    raise exception 'Нет права записывать возврат денег' using errcode = '42501';
  end if;
  select * into p from public.payments where id = p_payment_id for update;
  v_kind := case when p.kind = 'advance' then p.advance_for else private.payment_released_kind(p.id) end;
  if p.id is null or v_kind is null then raise exception 'Аванс или переплата не найдены'; end if;
  if v_kind in ('goods', 'mixed') and not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к стоимости товара' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or round(p_amount, 2) <> p_amount then raise exception 'Укажите сумму возврата больше нуля, до копеек'; end if;
  if p_amount > private.payment_unapplied(p.id) then
    raise exception 'Возврат больше остатка: можно вернуть не больше %', private.payment_unapplied(p.id);
  end if;
  if p_received_on is null or p_received_on > private.business_today() then raise exception 'Дата возврата не может быть в будущем'; end if;
  if p_received_on < p.paid_on then raise exception 'Дата возврата раньше даты оплаты'; end if;
  if p_document_id is not null and not exists (select 1 from public.documents where id = p_document_id and archived_at is null) then
    raise exception 'Документ-основание не найден';
  end if;
  if v_note is not null and length(v_note) > 1000 then raise exception 'Основание длиннее 1000 символов'; end if;
  insert into public.payment_refunds(payment_id, amount, received_on, document_id, note, request_id, created_by)
  values (p.id, p_amount, p_received_on, p_document_id, v_note, p_request_id, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.record_payment_refund(uuid, uuid, numeric, date, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.record_payment_refund(uuid, uuid, numeric, date, uuid, text) to authenticated;

create or replace function public.apply_advance(p_request_id uuid, p_payment_id uuid, p_expense_id uuid, p_amount numeric)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p public.payments;
  e public.expenses;
  v_id uuid;
  v_kind text;
  v_label text;
begin
  if p_request_id is null then raise exception 'Обновите страницу'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 170700));
  select id into v_id from public.payment_applications where request_id = p_request_id;
  if found then return v_id; end if;
  if not (select private.has_permission('finance.pay')) then raise exception 'Нет права подтверждать оплату' using errcode = '42501'; end if;
  -- An advance, or a payment whose expense was reversed: what it paid is the payee's debt to us (202611210200).
  select * into p from public.payments where id = p_payment_id for update;
  v_kind := case when p.kind = 'advance' then p.advance_for else private.payment_released_kind(p.id) end;
  if p.id is null or v_kind is null then raise exception 'Аванс или переплата не найдены'; end if;
  if v_kind = 'mixed' then raise exception 'Переплата относится и к товару, и к услугам: зачтите её вручную через бухгалтерию'; end if;
  v_label := case when p.kind = 'advance' then 'Аванс' else 'Переплату' end;
  select * into e from public.expenses where id = p_expense_id for update;
  if not found then raise exception 'Расход не найден'; end if;
  if (v_kind = 'goods' or e.expense_type = 'goods_cost') and not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к стоимости товара' using errcode = '42501';
  end if;
  -- An advance for goods pays for goods, an advance for services pays for services (audit 2026-11-18, Н2).
  if v_kind = 'goods' and e.expense_type <> 'goods_cost' then
    raise exception '% за товар нельзя зачесть в расход за услуги', v_label;
  end if;
  if v_kind = 'services' and e.expense_type = 'goods_cost' then
    raise exception '% за услуги нельзя зачесть в расход за товар', v_label;
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


-- Register: the overpayments next to the debt and the advances.
create or replace function public.payables_summary()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.business_today();
begin
  if not (select private.has_permission('finance.view')) then raise exception 'Нет доступа к кредиторке' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'payee_id', k.payee_id, 'payee', coalesce(c.short_name, c.legal_name), 'currency', cur.code,
            'accrued', coalesce(x.accrued, 0)::text, 'paid', coalesce(x.paid, 0)::text, 'rest', (coalesce(x.accrued, 0) - coalesce(x.paid, 0))::text,
            'advances', coalesce(a.remaining, 0)::text, 'overpaid', coalesce(o.remaining, 0)::text,
            'open_expenses', coalesce(x.open_count, 0), 'no_due_date', coalesce(x.no_due, 0), 'nearest_due', x.nearest_due,
            'overdue_amount', coalesce(x.overdue_amount, 0)::text, 'overdue_days', x.overdue_days)
            order by (x.overdue_days is null), x.overdue_days desc, coalesce(c.short_name, c.legal_name), cur.code), '[]'::jsonb)
    from (select p.payee_id, p.currency_id from private.payable_expenses() p
          union select o.payee_id, o.currency_id from private.open_advances() o
          union select o.payee_id, o.currency_id from private.open_overpayments() o) k
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
    left join (select o.payee_id, o.currency_id, sum(o.remaining) as remaining from private.open_overpayments() o group by o.payee_id, o.currency_id) o
      on o.payee_id is not distinct from k.payee_id and o.currency_id = k.currency_id
    left join public.counterparties c on c.id = k.payee_id
    join public.currencies cur on cur.id = k.currency_id);
end $$;
revoke all on function public.payables_summary() from public, anon, authenticated, service_role;
grant execute on function public.payables_summary() to authenticated;


-- Payee card: refunds and overpayments.
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
            from public.payment_applications a where a.payment_id = p.id),
        'refunds', private.payment_refund_list(p.id))
        order by (private.payment_unapplied(p.id) = 0), p.paid_on desc, p.created_at desc), '[]'::jsonb)
      from public.payments p join public.currencies cur on cur.id = p.currency_id left join public.profiles pr on pr.id = p.created_by
     where p.kind = 'advance' and p.payee_counterparty_id = p_payee_id
       and (p.advance_for <> 'goods' or (select private.has_permission('prices.purchase.view')))),
    -- Payments of reversed expenses: what they paid is the payee's debt, returned or set off (202611210200).
    'overpayments', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'currency', cur.code, 'currency_id', p.currency_id, 'amount', p.amount::text, 'paid_on', p.paid_on,
        'advance_for', private.payment_released_kind(p.id), 'remaining', private.payment_unapplied(p.id)::text,
        'note', p.note, 'author', pr.full_name,
        'reversed', (select coalesce(jsonb_agg(jsonb_build_object('expense_id', e.id, 'type', e.expense_type, 'expense_amount', e.amount::text,
              'paid', a.amount::text, 'reversed_at', e.reversed_at, 'reason', e.reversal_reason) order by e.reversed_at), '[]'::jsonb)
            from public.payment_applications a join public.expenses e on e.id = a.expense_id
           where a.payment_id = p.id and e.status = 'reversed'),
        'applications', (select coalesce(jsonb_agg(jsonb_build_object('expense_id', a.expense_id, 'amount', a.amount::text,
              'created_at', a.created_at) order by a.created_at), '[]'::jsonb)
            from public.payment_applications a join public.expenses e on e.id = a.expense_id
           where a.payment_id = p.id and e.status <> 'reversed'),
        'refunds', private.payment_refund_list(p.id))
        order by (private.payment_unapplied(p.id) = 0), p.paid_on desc, p.created_at desc), '[]'::jsonb)
      from public.payments p join public.currencies cur on cur.id = p.currency_id left join public.profiles pr on pr.id = p.created_by
     where p.kind = 'payment' and p.payee_counterparty_id = p_payee_id and private.payment_released_kind(p.id) is not null
       and (private.payment_released_kind(p.id) = 'services' or (select private.has_permission('prices.purchase.view')))));
end $$;
revoke all on function public.payables_payee(uuid) from public, anon, authenticated, service_role;
grant execute on function public.payables_payee(uuid) to authenticated;
commit;
