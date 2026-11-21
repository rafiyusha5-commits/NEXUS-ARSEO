-- Audit of 2026-11-18, finding Н2: apply_advance (202611170700) did not compare the kind of the advance with the
-- expense, so an advance for services could be set off against the cost of goods and the other way round.
-- An advance for goods ("goods") is set off only against "goods_cost", an advance for services only against the
-- other expense types. Applications made before this migration are kept as they are (history is never edited).
begin;

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
  -- An advance for goods pays for goods, an advance for services pays for services (audit 2026-11-18, Н2).
  if p.advance_for = 'goods' and e.expense_type <> 'goods_cost' then
    raise exception 'Аванс за товар нельзя зачесть в расход за услуги';
  end if;
  if p.advance_for = 'services' and e.expense_type = 'goods_cost' then
    raise exception 'Аванс за услуги нельзя зачесть в расход за товар';
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

commit;
