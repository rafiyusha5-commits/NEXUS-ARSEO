-- The purchase price is converted at the rate of the day the goods came, not of the day of the calculation.
-- Audit 2026-10-13, finding Н9.
--
-- calculate_shipment_cost converted the purchase price at the rate of current_date, while expenses use the rate of
-- their own date: the same calculation repeated a month later gave another cost. The day of the rate is now fixed
-- by the goods themselves:
--   receipt      the day the item was received (the receipt of its truck, corrected dates included);
--   loading      not received yet: the day its truck was actually loaded;
--   calculation  neither yet: the business day of the calculation, an estimate until the goods move;
--   expense      the goods cost was entered as an expense: its allocation is used, already converted at the
--                rate of the expense date, and no rate of the purchase price is needed.
-- Each line of the calculation keeps the rate, its day and the basis, so a calculation can be checked and repeated.
begin;

alter table public.cost_calculation_items
  add column if not exists goods_rate numeric check (goods_rate is null or goods_rate>0),
  add column if not exists goods_rate_date date,
  add column if not exists goods_rate_basis text check (goods_rate_basis in ('expense','receipt','loading','calculation'));

-- The day whose rate converts the purchase price of a shipment item, and why that day.
create or replace function private.shipment_item_rate_date(p_shipment_item_id uuid)
returns table(rate_date date, basis text) language plpgsql stable security definer set search_path='' as $$
declare v_day date;
begin
  select (min(r.received_at) at time zone 'Asia/Almaty')::date into v_day
  from public.shipment_items i join public.shipment_transport_receipts r on r.shipment_transport_id=i.shipment_transport_id
  where i.id=p_shipment_item_id;
  if v_day is null then
    -- received without a truck receipt (receive_inventory_batch): the first receipt movement of the item
    select (min(m.created_at) at time zone 'Asia/Almaty')::date into v_day
    from public.inventory_movements m where m.shipment_item_id=p_shipment_item_id and m.movement_type='receipt' and not m.is_reversal;
  end if;
  if v_day is not null then return query select v_day,'receipt'::text; return; end if;
  select t.actual_loading_date into v_day
  from public.shipment_items i join public.shipment_transports t on t.id=i.shipment_transport_id
  where i.id=p_shipment_item_id and t.status<>'cancelled';
  if v_day is not null then return query select v_day,'loading'::text; return; end if;
  return query select (now() at time zone 'Asia/Almaty')::date,'calculation'::text;
end $$;
revoke all on function private.shipment_item_rate_date(uuid) from public,anon,authenticated,service_role;

create or replace function public.calculate_shipment_cost(p_shipment_id uuid,p_target_currency_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;v_version integer;v_goods numeric;v_expenses numeric;v_goods_item numeric;v_exp_item numeric;r record;v_rate numeric;
 v_lost text;v_planned numeric;v_planned_without_rate integer;v_goods_allocated numeric;v_rate_date date;v_basis text;
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
 for r in select i.*,coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity) qty,pr.internal_sku
  from public.shipment_items i join public.products pr on pr.id=i.product_id
  where i.shipment_id=p_shipment_id and coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)>0 order by i.id loop
  select nullif(sum(a.allocated_amount) filter(where e.expense_type='goods_cost'),0),coalesce(sum(a.allocated_amount) filter(where e.expense_type<>'goods_cost'),0)
  into v_goods_allocated,v_exp_item from public.expense_allocations a join public.expenses e on e.id=a.expense_id
  where a.shipment_item_id=r.id and not e.is_planned and e.status in ('allocated','paid');
  if v_goods_allocated is not null then
   v_goods_item:=v_goods_allocated;v_rate:=null;v_rate_date:=null;v_basis:='expense';
  else
   if r.unit_price is null or r.currency_id is null then raise exception 'У позиции поставки не заполнена закупочная цена или валюта';end if;
   select d.rate_date,d.basis into v_rate_date,v_basis from private.shipment_item_rate_date(r.id) d;
   select fr.rate into v_rate from private.finance_rate(r.currency_id,p_target_currency_id,v_rate_date) fr;
   if v_rate is null then
    raise exception 'Нет курса % → % на % для закупочной цены %: добавьте курс на эту дату или раньше',
     (select code from public.currencies where id=r.currency_id),(select code from public.currencies where id=p_target_currency_id),
     to_char(v_rate_date,'DD.MM.YYYY'),r.internal_sku;
   end if;
   v_goods_item:=round(r.qty*r.unit_price*v_rate,2);
  end if;
  insert into public.cost_calculation_items(calculation_id,shipment_item_id,product_id,quantity,goods_amount,allocated_expenses,landed_amount,unit_landed_cost,currency_id,
   goods_rate,goods_rate_date,goods_rate_basis)
  values(v_id,r.id,r.product_id,r.qty,v_goods_item,v_exp_item,round(v_goods_item+v_exp_item,2),round((v_goods_item+v_exp_item)/r.qty,4),p_target_currency_id,
   v_rate,v_rate_date,v_basis);
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
revoke all on function public.calculate_shipment_cost(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.calculate_shipment_cost(uuid,uuid) to authenticated;

commit;
