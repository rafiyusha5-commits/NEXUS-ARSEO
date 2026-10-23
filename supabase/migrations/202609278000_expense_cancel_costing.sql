-- Audit 2026-10-13, findings Н3 and Н4 (docs/audit-2026-10-13.md).
-- Н3: a shipment item that did not arrive (received quantity 0) blocked the allocation of every expense
--     and broke the landed-cost calculation. Such items are now left out of allocation and costing.
-- Н4: an expense could not be cancelled, and planned and actual expenses were added together.
--     Decision of ARSEO: only actual expenses form the landed cost, planned ones are kept for comparison;
--     an unpaid expense is cancelled with a reason, a paid one is reversed (storno) with a reason.
-- An approved landed cost must describe the expenses and quantities that exist at approval, so a
-- calculation remembers a digest of its inputs and cannot be approved once they change.

alter table public.expenses drop constraint if exists expenses_status_check;
alter table public.expenses add constraint expenses_status_check
 check(status in ('draft','confirmed','allocated','paid','cancelled','reversed'));
alter table public.expenses
 add column if not exists cancelled_by uuid references public.profiles(id) on delete restrict,
 add column if not exists cancelled_at timestamptz,
 add column if not exists cancellation_reason text,
 add column if not exists reversed_by uuid references public.profiles(id) on delete restrict,
 add column if not exists reversed_at timestamptz,
 add column if not exists reversal_reason text;
alter table public.expenses drop constraint if exists expenses_cancellation_check;
alter table public.expenses add constraint expenses_cancellation_check check(
 (status='cancelled')=(cancelled_at is not null)
 and (cancelled_at is null or (cancelled_by is not null and btrim(coalesce(cancellation_reason,''))<>'')));
alter table public.expenses drop constraint if exists expenses_reversal_check;
alter table public.expenses add constraint expenses_reversal_check check(
 (status='reversed')=(reversed_at is not null)
 and (reversed_at is null or (reversed_by is not null and paid_at is not null and btrim(coalesce(reversal_reason,''))<>'')));
comment on column public.expenses.is_planned is 'Planned (estimate before the invoice) or actual. Only actual expenses enter the landed cost; planned ones are compared with it';
comment on column public.expenses.cancellation_reason is 'Why an unpaid expense was cancelled (status cancelled)';
comment on column public.expenses.reversal_reason is 'Why a paid expense was reversed (status reversed, storno)';

alter table public.cost_calculations
 add column if not exists planned_expenses_total numeric(14,2),
 add column if not exists planned_expenses_without_rate integer not null default 0,
 add column if not exists inputs_digest text;
comment on column public.cost_calculations.planned_expenses_total is 'Planned additional expenses (goods cost excluded) in the calculation currency, for comparison with expenses_total; null when nothing could be converted';
comment on column public.cost_calculations.planned_expenses_without_rate is 'Planned expenses left out of planned_expenses_total because no exchange rate existed on their date';
comment on column public.cost_calculations.inputs_digest is 'Digest of the quantities, prices, expenses and allocations used; approval requires it to be unchanged';

-- Everything a calculation depends on, except exchange rates. Payment of an allocated expense does not
-- change the landed cost, so actual expenses are bucketed as included ("fact") or not yet allocated ("open").
create or replace function private.shipment_cost_inputs_digest(p_shipment_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select md5(coalesce(string_agg(part,'|' order by part),'')) from (
  select concat_ws(':','item',i.id,coalesce(coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)::text,'-'),
   coalesce(i.unit_price::text,'-'),coalesce(i.currency_id::text,'-')) part
  from public.shipment_items i where i.shipment_id=p_shipment_id
  union all
  select concat_ws(':','expense',e.id,e.expense_type,e.amount,e.currency_id,e.incurred_at,
   case when e.is_planned then 'plan' when e.status in ('allocated','paid') then 'fact' else 'open' end)
  from public.expenses e where e.shipment_id=p_shipment_id and e.status not in ('cancelled','reversed')
  union all
  select concat_ws(':','allocation',a.id,a.shipment_item_id,a.allocated_amount,a.currency_id)
  from public.expense_allocations a join public.expenses e on e.id=a.expense_id
  where e.shipment_id=p_shipment_id and not e.is_planned and e.status in ('allocated','paid')
 ) parts
$$;
revoke all on function private.shipment_cost_inputs_digest(uuid) from public,anon,authenticated,service_role;

-- Items with nothing received are not part of the basis. A paid expense can be re-allocated (the goods often
-- arrive after the carrier is paid) and stays paid. Planned expenses are not allocated at all.
create or replace function public.allocate_expense(p_expense_id uuid,p_method text,p_target_currency_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare e record;r record;v_rate numeric;v_rate_id uuid;v_total numeric:=0;v_amount numeric;v_left numeric;v_n integer;v_i integer:=0;v_missing text;
begin
 if not (select private.has_permission('costing.calculate')) then raise exception 'Нет права распределять расходы';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 if p_method not in ('by_quantity','by_weight','by_volume','by_value') then raise exception 'Выберите способ распределения';end if;
 select * into e from public.expenses where id=p_expense_id and status in ('confirmed','allocated','paid') and shipment_id is not null for update;
 if not found then raise exception 'Сначала подтвердите расход';end if;
 if e.is_planned then raise exception 'Плановый расход не распределяется: в себестоимость входят только фактические расходы';end if;
 select rate_id,rate into v_rate_id,v_rate from private.finance_rate(e.currency_id,p_target_currency_id,e.incurred_at);
 if v_rate is null then raise exception 'Нет курса валюты на дату расхода';end if;
 update public.expenses set exchange_rate_id=v_rate_id where id=e.id;
 delete from public.expense_allocations where expense_id=e.id;
 create temporary table if not exists pg_temp.expense_allocation_basis(item_id uuid,sku text,basis numeric) on commit drop;
 truncate pg_temp.expense_allocation_basis;
 insert into pg_temp.expense_allocation_basis
 select i.id,pr.internal_sku,case p_method when 'by_quantity' then q.qty when 'by_value' then q.qty*i.unit_price
  when 'by_weight' then q.qty*p.gross_weight_kg else q.qty*p.volume_m3 end
 from public.shipment_items i join public.products pr on pr.id=i.product_id
 cross join lateral(select coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity) qty)q
 left join lateral(select pp.gross_weight_kg,coalesce(pp.volume_m3,(pp.length_cm*pp.width_cm*pp.height_cm)/1000000) volume_m3
  from public.product_packaging pp where pp.product_id=i.product_id and pp.uom=i.uom limit 1)p on true
 where i.shipment_id=e.shipment_id and q.qty>0;
 select string_agg(distinct sku,', ' order by sku) into v_missing from pg_temp.expense_allocation_basis where basis is null or basis<=0;
 if v_missing is not null then raise exception 'Для выбранного способа не хватает цены, веса или объёма у позиций: %',v_missing;end if;
 select sum(basis),count(*) into v_total,v_n from pg_temp.expense_allocation_basis;
 if coalesce(v_total,0)<=0 then raise exception 'В поставке нет принятого товара: распределять расход не на что';end if;
 v_amount:=round(e.amount*v_rate,2);v_left:=v_amount;
 for r in select * from pg_temp.expense_allocation_basis order by item_id loop v_i:=v_i+1;
  insert into public.expense_allocations(expense_id,shipment_item_id,allocation_method,allocation_basis,allocation_share,allocated_amount,currency_id)
  values(e.id,r.item_id,p_method,r.basis,r.basis/v_total,case when v_i=v_n then v_left else round(v_amount*r.basis/v_total,2) end,p_target_currency_id);
  if v_i<v_n then v_left:=v_left-round(v_amount*r.basis/v_total,2);end if;
 end loop;
 update public.expenses set status=case when status='confirmed' then 'allocated' else status end,updated_at=now() where id=e.id;
end $$;

create or replace function public.calculate_shipment_cost(p_shipment_id uuid,p_target_currency_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;v_version integer;v_goods numeric;v_expenses numeric;v_goods_item numeric;v_exp_item numeric;r record;v_rate numeric;
 v_lost text;v_planned numeric;v_planned_without_rate integer;
begin
 if not (select private.has_permission('costing.calculate')) then raise exception 'Нет права рассчитывать себестоимость';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 -- Hold the input set constant for the whole calculation, including concurrent INSERTs.
 -- Row locks alone cannot protect new expenses/items. These short transaction-level table
 -- locks also serialize cost versions; no external calls occur while they are held.
 lock table public.expenses, public.shipment_items, public.expense_allocations in exclusive mode;
 if exists(select 1 from public.expenses where shipment_id=p_shipment_id and not is_planned and status in ('draft','confirmed')) then
  raise exception 'Подтвердите и распределите фактические расходы поставки или отмените ошибочные';end if;
 if exists(select 1 from public.expenses e join public.expense_allocations a on a.expense_id=e.id
  where e.shipment_id=p_shipment_id and not e.is_planned and e.status in ('allocated','paid') and a.currency_id<>p_target_currency_id) then
  raise exception 'Все расходы должны быть распределены в валюте расчёта';end if;
 if not exists(select 1 from public.shipment_items where shipment_id=p_shipment_id) then raise exception 'В поставке нет товаров';end if;
 -- An expense spread before the receipt may hold a share of an item that did not arrive; skipping that
 -- share would silently lose money, so the expense has to be allocated again.
 select string_agg(distinct pr.internal_sku,', ' order by pr.internal_sku) into v_lost
 from public.expense_allocations a join public.expenses e on e.id=a.expense_id
 join public.shipment_items i on i.id=a.shipment_item_id join public.products pr on pr.id=i.product_id
 where e.shipment_id=p_shipment_id and not e.is_planned and e.status in ('allocated','paid')
  and coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)<=0;
 if v_lost is not null then raise exception 'Часть расходов распределена на позиции без прихода (%): распределите эти расходы заново',v_lost;end if;
 if not exists(select 1 from public.shipment_items where shipment_id=p_shipment_id
  and coalesce(received_quantity,shipped_quantity,confirmed_quantity,ordered_quantity)>0) then
  raise exception 'В поставке нет принятого товара: рассчитывать себестоимость не из чего';end if;
 select coalesce(max(version_number),0)+1 into v_version from public.cost_calculations where shipment_id=p_shipment_id;
 insert into public.cost_calculations(shipment_id,version_number,currency_id) values(p_shipment_id,v_version,p_target_currency_id) returning id into v_id;
 for r in select i.*,coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity) qty from public.shipment_items i
  where i.shipment_id=p_shipment_id and coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)>0 order by i.id loop
  if r.unit_price is null or r.currency_id is null then raise exception 'У позиции поставки не заполнена закупочная цена или валюта';end if;
  select rate into v_rate from private.finance_rate(r.currency_id,p_target_currency_id,current_date);if v_rate is null then raise exception 'Нет курса для закупочной цены';end if;
  select coalesce(nullif(sum(a.allocated_amount) filter(where e.expense_type='goods_cost'),0),round(r.qty*r.unit_price*v_rate,2)),coalesce(sum(a.allocated_amount) filter(where e.expense_type<>'goods_cost'),0)
  into v_goods_item,v_exp_item from public.expense_allocations a join public.expenses e on e.id=a.expense_id
  where a.shipment_item_id=r.id and not e.is_planned and e.status in ('allocated','paid');
  insert into public.cost_calculation_items(calculation_id,shipment_item_id,product_id,quantity,goods_amount,allocated_expenses,landed_amount,unit_landed_cost,currency_id)
  values(v_id,r.id,r.product_id,r.qty,v_goods_item,v_exp_item,round(v_goods_item+v_exp_item,2),round((v_goods_item+v_exp_item)/r.qty,4),p_target_currency_id);
 end loop;
 select coalesce(sum(goods_amount),0),coalesce(sum(allocated_expenses),0) into v_goods,v_expenses from public.cost_calculation_items where calculation_id=v_id;
 select sum(round(e.amount*fr.rate,2)),count(*) filter(where fr.rate is null) into v_planned,v_planned_without_rate
 from public.expenses e left join lateral private.finance_rate(e.currency_id,p_target_currency_id,e.incurred_at) fr on true
 where e.shipment_id=p_shipment_id and e.is_planned and e.status not in ('cancelled','reversed') and e.expense_type<>'goods_cost';
 update public.cost_calculations set goods_total=v_goods,expenses_total=v_expenses,landed_total=v_goods+v_expenses,
  planned_expenses_total=v_planned,planned_expenses_without_rate=v_planned_without_rate,inputs_digest=private.shipment_cost_inputs_digest(p_shipment_id)
 where id=v_id;
 return v_id;
end $$;

create or replace function public.approve_shipment_cost(p_calculation_id uuid)
returns void language plpgsql security definer set search_path='' as $$declare c record;begin
 if not (select private.has_permission('costing.approve')) then raise exception 'Нет права утверждать себестоимость';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 lock table public.expenses, public.shipment_items, public.expense_allocations in exclusive mode;
 select * into c from public.cost_calculations where id=p_calculation_id and status='draft' for update;if not found then raise exception 'Расчёт не найден или уже утверждён';end if;
 if c.inputs_digest is null then raise exception 'Расчёт сделан по прежним правилам: рассчитайте новую версию';end if;
 -- Table locks protect both existing rows and new inputs until approval commits.
 -- Do not take expense row locks here: writers can already own them while waiting
 -- for the table lock, which would invert the locking order.
 if c.inputs_digest<>private.shipment_cost_inputs_digest(c.shipment_id) then
  raise exception 'После расчёта изменились расходы или позиции поставки: рассчитайте новую версию';end if;
 update public.cost_calculations set status='superseded' where shipment_id=c.shipment_id and status='approved';
 update public.cost_calculations set status='approved',approved_by=auth.uid(),approved_at=now() where id=c.id;
 update public.inventory_batches b set unit_landed_cost=i.unit_landed_cost,cost_currency_id=i.currency_id,cost_calculation_id=c.id,updated_at=now() from public.cost_calculation_items i where i.calculation_id=c.id and i.shipment_item_id=b.source_shipment_item_id;
end $$;

-- Before payment: finance.manage cancels any expense; with finance.draft only one's own draft.
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
 if v_reason is null then raise exception 'Укажите причину отмены';end if;
 if length(v_reason)>500 then raise exception 'Причина отмены длиннее 500 символов';end if;
 update public.expenses set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),cancellation_reason=v_reason,updated_at=now() where id=e.id;
end $$;

-- After payment the record stays as paid history and is reversed; a refund or a corrected expense is entered separately.
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
 if e.status<>'paid' then raise exception 'Сторнировать можно только оплаченный расход: неоплаченный отмените';end if;
 if v_reason is null then raise exception 'Укажите причину сторнирования';end if;
 if length(v_reason)>500 then raise exception 'Причина сторнирования длиннее 500 символов';end if;
 update public.expenses set status='reversed',reversed_by=auth.uid(),reversed_at=now(),reversal_reason=v_reason,updated_at=now() where id=e.id;
end $$;

do $$declare f text;begin foreach f in array array[
 'public.allocate_expense(uuid,text,uuid)','public.calculate_shipment_cost(uuid,uuid)','public.approve_shipment_cost(uuid)',
 'public.cancel_expense(uuid,text)','public.reverse_expense(uuid,text)'] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end $$;
