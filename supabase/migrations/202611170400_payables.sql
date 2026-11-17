-- Block 2: payables with partial payments. Owner decisions of 2026-11-16/17 (damirator1-afk), defaults accepted:
--   * suppliers and carriers are paid in parts; a payment is its own record (date, amount, author, document, note);
--   * a debt starts at "confirmed"; the due date is optional and entered by hand (carrier payment terms are a hint);
--     an expense without a due date is "срок не задан", never overdue;
--   * a partly paid expense cannot be cancelled, only reversed with a reason; its payments stay in history;
--   * mark_expense_paid and the assistant keep working as "pay the rest at once";
--   * advances (a payment before the expense exists) come in the next PR: a payment belongs to a payee and reaches
--     an expense through an application, so an advance is a payment without applications yet;
--   * no bank statement matching, no payment calendar in this block; planned expenses are not in the register.
-- The cost is independent of payments: cost calculation, approval, inputs_digest and table locks are not changed.
-- The expense status still moves allocated -> paid only when the expense is fully paid (both are "fact" for costing).
begin;

alter table public.expenses add column if not exists due_date date;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  payee_counterparty_id uuid references public.counterparties(id),
  currency_id uuid not null references public.currencies(id),
  amount numeric(14, 2) not null check (amount > 0),
  paid_on date not null,
  document_id uuid references public.documents(id),
  note text check (note is null or length(note) <= 1000),
  request_id uuid unique,
  legacy boolean not null default false,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists public.payment_applications (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id),
  expense_id uuid not null references public.expenses(id),
  amount numeric(14, 2) not null check (amount > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists payments_payee_idx on public.payments(payee_counterparty_id, currency_id);
create index if not exists payments_document_idx on public.payments(document_id);
create index if not exists payments_created_by_idx on public.payments(created_by);
create index if not exists payment_applications_expense_idx on public.payment_applications(expense_id);
create index if not exists payment_applications_payment_idx on public.payment_applications(payment_id);
create index if not exists payment_applications_created_by_idx on public.payment_applications(created_by);
alter table public.payments enable row level security;
alter table public.payment_applications enable row level security;
revoke all on public.payments, public.payment_applications from public, anon, authenticated, service_role;

-- Payments are history: never edited or deleted.
create or replace function private.guard_payment_history() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'История оплат неизменяема' using errcode = '42501';
end $$;
revoke all on function private.guard_payment_history() from public, anon, authenticated, service_role;
drop trigger if exists payments_immutable on public.payments;
create trigger payments_immutable before update or delete on public.payments for each row execute function private.guard_payment_history();
drop trigger if exists payment_applications_immutable on public.payment_applications;
create trigger payment_applications_immutable before update or delete on public.payment_applications for each row execute function private.guard_payment_history();

create or replace function private.expense_paid_amount(p_expense_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from public.payment_applications where expense_id = p_expense_id
$$;
revoke all on function private.expense_paid_amount(uuid) from public, anon, authenticated, service_role;

-- The database refuses an overpayment, a payment in another currency, or a payment of an expense that is not a debt,
-- whatever inserts it. The expense row is locked, so two people paying at once are serialized.
create or replace function private.check_payment_application() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  e public.expenses;
  p public.payments;
begin
  select * into e from public.expenses where id = new.expense_id for update;
  select * into p from public.payments where id = new.payment_id;
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
    raise exception 'Оплата уже распределена полностью';
  end if;
  return new;
end $$;
revoke all on function private.check_payment_application() from public, anon, authenticated, service_role;
drop trigger if exists payment_applications_check on public.payment_applications;
create trigger payment_applications_check before insert on public.payment_applications
  for each row execute function private.check_payment_application();

-- A fully paid expense that gets allocated later becomes paid at once (allocated and paid are both "fact" for cost).
create or replace function private.expense_paid_on_allocation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_last public.payments;
begin
  if new.status = 'allocated' and old.status is distinct from 'allocated' and private.expense_paid_amount(new.id) >= new.amount then
    select p.* into v_last from public.payment_applications a join public.payments p on p.id = a.payment_id
     where a.expense_id = new.id order by a.created_at desc, a.id desc limit 1;
    new.status := 'paid';
    new.paid_by := v_last.created_by;
    new.paid_at := v_last.created_at;
  end if;
  return new;
end $$;
revoke all on function private.expense_paid_on_allocation() from public, anon, authenticated, service_role;
drop trigger if exists expenses_paid_on_allocation on public.expenses;
create trigger expenses_paid_on_allocation before update of status on public.expenses
  for each row execute function private.expense_paid_on_allocation();

-- Existing paid expenses: one payment of the whole amount with the former date and author (also for reversed ones).
-- Idempotent: an expense that already has a payment is skipped. Kept as a function so the test can run it.
create or replace function private.backfill_legacy_payments() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; v_payment uuid; v_count integer := 0;
begin
  for r in select e.* from public.expenses e
            where e.paid_at is not null and e.paid_by is not null
              and not exists (select 1 from public.payment_applications a where a.expense_id = e.id)
            order by e.paid_at, e.id
  loop
    insert into public.payments(payee_counterparty_id, currency_id, amount, paid_on, legacy, created_by, created_at, note)
    values (r.payee_counterparty_id, r.currency_id, r.amount, (r.paid_at at time zone 'Asia/Almaty')::date, true,
            r.paid_by, r.paid_at, 'Оплата, внесённая до учёта частичных оплат')
    returning id into v_payment;
    insert into public.payment_applications(payment_id, expense_id, amount, created_by, created_at)
    values (v_payment, r.id, r.amount, r.paid_by, r.paid_at);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke all on function private.backfill_legacy_payments() from public, anon, authenticated, service_role;
select private.backfill_legacy_payments();

-- Access ---------------------------------------------------------------------------------------------------------
create or replace function private.require_expense_payment(e public.expenses) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('finance.pay')) then raise exception 'Нет права подтверждать оплату' using errcode = '42501'; end if;
  if e.expense_type = 'goods_cost' and not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к стоимости товара' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_expense_payment(public.expenses) from public, anon, authenticated, service_role;

-- Recording payments ---------------------------------------------------------------------------------------------
-- One payment of a part (or the rest) of one expense. Repeating the same request returns the same payment.
create or replace function public.record_expense_payment(p_request_id uuid, p_expense_id uuid, p_amount numeric, p_paid_on date,
                                                         p_document_id uuid default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  e public.expenses;
  v_id uuid;
  v_paid numeric;
begin
  if p_request_id is null then raise exception 'Обновите страницу'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 170400));
  select id into v_id from public.payments where request_id = p_request_id;
  if found then return v_id; end if;
  select * into e from public.expenses where id = p_expense_id for update;
  if not found then raise exception 'Расход не найден'; end if;
  perform private.require_expense_payment(e);
  if p_amount is null or p_amount <= 0 or round(p_amount, 2) <> p_amount then raise exception 'Укажите сумму оплаты больше нуля, до копеек'; end if;
  if p_paid_on is null or p_paid_on > private.business_today() then raise exception 'Дата оплаты не может быть в будущем'; end if;
  if p_document_id is not null and not exists (select 1 from public.documents where id = p_document_id and archived_at is null) then
    raise exception 'Документ-основание не найден';
  end if;
  insert into public.payments(payee_counterparty_id, currency_id, amount, paid_on, document_id, note, request_id, created_by)
  values (e.payee_counterparty_id, e.currency_id, p_amount, p_paid_on, p_document_id, nullif(btrim(coalesce(p_note, '')), ''), p_request_id, auth.uid())
  returning id into v_id;
  insert into public.payment_applications(payment_id, expense_id, amount, created_by) values (v_id, e.id, p_amount, auth.uid());
  v_paid := private.expense_paid_amount(e.id);
  if v_paid >= e.amount and e.status = 'allocated' then
    update public.expenses set status = 'paid', paid_by = auth.uid(), paid_at = now(), updated_at = now() where id = e.id;
  end if;
  return v_id;
end $$;
revoke all on function public.record_expense_payment(uuid, uuid, numeric, date, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.record_expense_payment(uuid, uuid, numeric, date, uuid, text) to authenticated;

-- The former action, now "pay the rest at once": only an allocated expense, as before.
create or replace function public.mark_expense_paid(p_expense_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  e public.expenses;
  v_rest numeric;
  v_payment uuid;
begin
  select * into e from public.expenses where id = p_expense_id for update;
  if not (select private.has_permission('finance.pay')) then raise exception 'Нет права подтверждать оплату'; end if;
  if e.expense_type = 'goods_cost' and not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к стоимости товара' using errcode = '42501';
  end if;
  if e.id is null or e.status <> 'allocated' then raise exception 'Оплатить можно только распределённый расход'; end if;
  v_rest := e.amount - private.expense_paid_amount(e.id);
  if v_rest > 0 then
    insert into public.payments(payee_counterparty_id, currency_id, amount, paid_on, created_by)
    values (e.payee_counterparty_id, e.currency_id, v_rest, private.business_today(), auth.uid()) returning id into v_payment;
    insert into public.payment_applications(payment_id, expense_id, amount, created_by) values (v_payment, e.id, v_rest, auth.uid());
  end if;
  update public.expenses set status = 'paid', paid_by = auth.uid(), paid_at = now(), updated_at = now() where id = e.id;
end $$;
revoke all on function public.mark_expense_paid(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_expense_paid(uuid) to authenticated;

-- Cancellation (202609278000) unchanged, except that a partly paid expense is reversed, not cancelled.
create or replace function public.cancel_expense(p_expense_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare e record;v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');v_manage boolean:=(select private.has_permission('finance.manage'));
begin
 if not (v_manage or (select private.has_permission('finance.draft'))) then raise exception 'Нет права отменять расходы' using errcode='42501';end if;
 select * into e from public.expenses where id=p_expense_id for update;
 if not found then raise exception 'Расход не найден';end if;
 if e.expense_type='goods_cost' and not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к стоимости товара' using errcode='42501';end if;
 if e.status in ('cancelled','reversed') then raise exception 'Расход уже отменён или сторнирован';end if;
 if not v_manage and (e.status<>'draft' or e.created_by is distinct from auth.uid()) then
  raise exception 'Без права управления финансами можно отменить только свой черновик' using errcode='42501';end if;
 if e.status='paid' then raise exception 'Оплаченный расход нельзя отменить: оформите сторнирование';end if;
 if private.expense_paid_amount(e.id)>0 then raise exception 'Расход частично оплачен: отмена невозможна, оформите сторнирование';end if;
 if v_reason is null then raise exception 'Укажите причину отмены';end if;
 if length(v_reason)>500 then raise exception 'Причина отмены длиннее 500 символов';end if;
 update public.expenses set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),cancellation_reason=v_reason,updated_at=now() where id=e.id;
end $$;

-- Reversal (202609278000) unchanged, and also for a partly paid expense; its payments stay in history. A partly
-- paid expense has no paid_at (it was never paid in full): the row rule "only a paid expense is reversed" moves from
-- the column check to a trigger that accepts paid_at or recorded payments, with the same check_violation.
alter table public.expenses drop constraint if exists expenses_reversal_check;
alter table public.expenses add constraint expenses_reversal_check check(
 (status='reversed')=(reversed_at is not null)
 and (reversed_at is null or (reversed_by is not null and btrim(coalesce(reversal_reason,''))<>'')));
create or replace function private.expense_reversal_needs_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.reversed_at is not null and new.paid_at is null and private.expense_paid_amount(new.id) = 0 then
    raise exception 'Сторнировать можно только расход с оплатой' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function private.expense_reversal_needs_payment() from public, anon, authenticated, service_role;
drop trigger if exists expenses_reversal_needs_payment on public.expenses;
create trigger expenses_reversal_needs_payment before insert or update of status, reversed_at, paid_at on public.expenses
  for each row execute function private.expense_reversal_needs_payment();
-- Reversal (202609278000) unchanged, and also for a partly paid expense; its payments stay in history.
create or replace function public.reverse_expense(p_expense_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare e record;v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
 if not ((select private.has_permission('finance.manage')) and (select private.has_permission('finance.pay'))) then
  raise exception 'Нет права сторнировать расходы' using errcode='42501';end if;
 select * into e from public.expenses where id=p_expense_id for update;
 if not found then raise exception 'Расход не найден';end if;
 if e.expense_type='goods_cost' and not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к стоимости товара' using errcode='42501';end if;
 if e.status in ('cancelled','reversed') then raise exception 'Расход уже отменён или сторнирован';end if;
 if e.status<>'paid' and private.expense_paid_amount(e.id)=0 then raise exception 'Сторнировать можно только оплаченный расход: неоплаченный отмените';end if;
 if v_reason is null then raise exception 'Укажите причину сторнирования';end if;
 if length(v_reason)>500 then raise exception 'Причина сторнирования длиннее 500 символов';end if;
 update public.expenses set status='reversed',reversed_by=auth.uid(),reversed_at=now(),reversal_reason=v_reason,updated_at=now() where id=e.id;
end $$;
do $$declare f text;begin foreach f in array array['public.cancel_expense(uuid,text)','public.reverse_expense(uuid,text)'] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end $$;

create or replace function public.set_expense_due_date(p_expense_id uuid, p_due_date date)
returns void
language plpgsql security definer set search_path = '' as $$
declare e public.expenses;
begin
  if not (select private.has_permission('finance.manage')) then raise exception 'Нет права изменять срок оплаты' using errcode = '42501'; end if;
  select * into e from public.expenses where id = p_expense_id for update;
  if not found then raise exception 'Расход не найден'; end if;
  if e.expense_type = 'goods_cost' and not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к стоимости товара' using errcode = '42501';
  end if;
  if e.status in ('cancelled', 'reversed') then raise exception 'Расход отменён или сторнирован'; end if;
  update public.expenses set due_date = p_due_date, updated_at = now() where id = e.id;
end $$;
revoke all on function public.set_expense_due_date(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.set_expense_due_date(uuid, date) to authenticated;

-- Register -------------------------------------------------------------------------------------------------------
-- Debts: actual expenses from "confirmed" on, not cancelled or reversed. Goods cost only with purchase-price access.
create or replace function private.payable_expenses()
returns table(expense_id uuid, payee_id uuid, currency_id uuid, expense_type text, amount numeric, paid numeric,
              due_date date, incurred_at date, status text, shipment_id uuid)
language sql stable security definer set search_path = '' as $$
  select e.id, e.payee_counterparty_id, e.currency_id, e.expense_type, e.amount, private.expense_paid_amount(e.id),
         e.due_date, e.incurred_at, e.status, e.shipment_id
    from public.expenses e
   where not e.is_planned and e.status in ('confirmed', 'allocated', 'paid')
     and (e.expense_type <> 'goods_cost' or (select private.has_permission('prices.purchase.view')))
$$;
revoke all on function private.payable_expenses() from public, anon, authenticated, service_role;

-- By payee and currency (amounts in different currencies are never added): accrued, paid, rest, overdue.
create or replace function public.payables_summary()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.business_today();
begin
  if not (select private.has_permission('finance.view')) then raise exception 'Нет доступа к кредиторке' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'payee_id', x.payee_id, 'payee', coalesce(c.short_name, c.legal_name), 'currency', cur.code,
            'accrued', x.accrued::text, 'paid', x.paid::text, 'rest', (x.accrued - x.paid)::text,
            'open_expenses', x.open_count, 'no_due_date', x.no_due, 'nearest_due', x.nearest_due,
            'overdue_amount', x.overdue_amount::text, 'overdue_days', x.overdue_days)
            order by (x.overdue_days is null), x.overdue_days desc, coalesce(c.short_name, c.legal_name), cur.code), '[]'::jsonb)
    from (select p.payee_id, p.currency_id, sum(p.amount) as accrued, sum(p.paid) as paid,
                 count(*) filter (where p.amount > p.paid) as open_count,
                 count(*) filter (where p.amount > p.paid and p.due_date is null) as no_due,
                 min(p.due_date) filter (where p.amount > p.paid and p.due_date >= v_today) as nearest_due,
                 coalesce(sum(p.amount - p.paid) filter (where p.amount > p.paid and p.due_date < v_today), 0) as overdue_amount,
                 max(v_today - p.due_date) filter (where p.amount > p.paid and p.due_date < v_today) as overdue_days
            from private.payable_expenses() p group by p.payee_id, p.currency_id) x
    left join public.counterparties c on c.id = x.payee_id
    join public.currencies cur on cur.id = x.currency_id);
end $$;
revoke all on function public.payables_summary() from public, anon, authenticated, service_role;
grant execute on function public.payables_summary() to authenticated;

-- One payee (null: expenses without a payee): every expense with its payments, and the carrier's payment terms hint.
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
    'expenses', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.expense_id, 'type', p.expense_type, 'status', p.status, 'currency', cur.code,
        'amount', p.amount::text, 'paid', p.paid::text, 'rest', (p.amount - p.paid)::text,
        'incurred_at', p.incurred_at, 'due_date', p.due_date,
        'overdue_days', case when p.amount > p.paid and p.due_date < v_today then v_today - p.due_date end,
        'shipment', s.shipment_number, 'shipment_id', p.shipment_id,
        'payments', (select coalesce(jsonb_agg(jsonb_build_object('amount', a.amount::text, 'paid_on', pay.paid_on,
              'author', pr.full_name, 'document', d.title, 'document_id', pay.document_id, 'note', pay.note,
              'legacy', pay.legacy, 'created_at', a.created_at) order by pay.paid_on, a.created_at), '[]'::jsonb)
            from public.payment_applications a join public.payments pay on pay.id = a.payment_id
            left join public.profiles pr on pr.id = pay.created_by left join public.documents d on d.id = pay.document_id
           where a.expense_id = p.expense_id))
        order by (p.amount <= p.paid), p.due_date nulls last, p.incurred_at), '[]'::jsonb)
      from private.payable_expenses() p join public.currencies cur on cur.id = p.currency_id
      left join public.shipments s on s.id = p.shipment_id
     where p.payee_id is not distinct from p_payee_id));
end $$;
revoke all on function public.payables_payee(uuid) from public, anon, authenticated, service_role;
grant execute on function public.payables_payee(uuid) to authenticated;

-- Assistant payment (202610241200): unchanged, except that an expense with recorded payments is not offered there
-- (the employee pays the rest in Финансы → Кредиторка) and payments are part of the reviewed state.
create or replace function private.assistant_expense_payment_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.expenses; s public.shipments; d public.documents; c public.currencies; cp public.counterparties; customer public.counterparties; stamp jsonb;
begin
 perform private.require_assistant_expense_payment_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_EXPENSE_PAYMENT_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>1 or jsonb_typeof(p->'expense_id') is distinct from 'string'
 then raise exception 'ASSISTANT_EXPENSE_PAYMENT_INVALID';end if;
 perform private.require_assistant_expense_payment_access((p->>'expense_id')::uuid);
 select * into e from public.expenses where id=(p->>'expense_id')::uuid;
 if e.status<>'allocated' or e.is_planned or e.paid_at is not null or e.paid_by is not null then raise exception 'ASSISTANT_EXPENSE_PAYMENT_STATE';end if;
 if exists(select 1 from public.payment_applications where expense_id=e.id) then raise exception 'ASSISTANT_EXPENSE_PAYMENT_STATE';end if;
 select * into s from public.shipments where id=e.shipment_id;
 select * into d from public.documents where id=e.document_id;
 select * into c from public.currencies where id=e.currency_id;
 select * into cp from public.counterparties where id=e.payee_counterparty_id;
 select * into customer from public.counterparties where id=e.attributed_customer_id;

 stamp:=jsonb_build_object('expense',to_jsonb(e),'shipment',to_jsonb(s),'currency',to_jsonb(c),'payee',to_jsonb(cp),'customer',to_jsonb(customer),'document',to_jsonb(d),
 'allocations',(select jsonb_agg(to_jsonb(a) order by a.id) from public.expense_allocations a where expense_id=e.id),
 'links',(select jsonb_agg(to_jsonb(l) order by l.id) from public.document_links l where document_id=e.document_id and removed_at is null),
 'payments',(select jsonb_agg(to_jsonb(a) order by a.id) from public.payment_applications a where expense_id=e.id));
 return jsonb_build_object('expense_id',e.id,'status',e.status,'allocation_count',(select count(*) from public.expense_allocations where expense_id=e.id),'shipment_number',s.shipment_number,'customer',coalesce(customer.short_name,customer.legal_name),
 'expense_type',e.expense_type,'payee',coalesce(cp.short_name,cp.legal_name),'amount',e.amount::text,'currency',c.code,
 'incurred_at',e.incurred_at,'amount_kind',case when e.is_planned then 'planned' else 'actual' end,'document',d.title,'notes',e.notes,
 'creator',(select full_name from public.profiles where id=e.created_by),'performer',(select full_name from public.profiles where id=auth.uid()),
 'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_EXPENSE_PAYMENT_INVALID';
end $$;
revoke all on function private.assistant_expense_payment_preview(jsonb) from public,anon,authenticated,service_role;

comment on table public.payments is 'Outgoing payments; reach expenses through payment_applications (an advance has none yet)';
comment on column public.expenses.due_date is 'Optional payment due date; without it the debt is "срок не задан", not overdue';
commit;
