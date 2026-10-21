-- Owner rule: paid 100 units / received 98 does not redistribute the cost of 100 over 98.
-- Existing approved calculations and inventory quantities are not rewritten.
alter table public.cost_calculation_items add column if not exists cost_quantity numeric(14,3) check(cost_quantity>0);
alter table public.cost_calculation_items add column if not exists cost_quantity_basis text check(cost_quantity_basis in ('received','shipped','confirmed','ordered'));
create or replace function private.shipment_cost_inputs_digest(p_shipment_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select md5('purchase-quantity-v1|'||coalesce(string_agg(part,'|' order by part),'')) from (
  select concat_ws(':','item',i.id,coalesce(coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)::text,'-'),
   coalesce(i.ordered_quantity::text,'-'),coalesce(i.confirmed_quantity::text,'-'),coalesce(i.shipped_quantity::text,'-'),coalesce(i.unit_price::text,'-'),coalesce(i.currency_id::text,'-'),coalesce(i.shipment_transport_id::text,'-')) part
  from public.shipment_items i where i.shipment_id=p_shipment_id
  union all
  select concat_ws(':','expense',e.id,e.expense_type,e.amount,e.currency_id,e.incurred_at,
   case when e.is_planned then 'plan' when e.status in ('allocated','paid') then 'fact' else 'open' end)
  from public.expenses e where e.shipment_id=p_shipment_id and e.status not in ('cancelled','reversed')
  union all
  select concat_ws(':','allocation',a.id,a.shipment_item_id,a.allocated_amount,a.currency_id)
  from public.expense_allocations a join public.expenses e on e.id=a.expense_id
  where e.shipment_id=p_shipment_id and not e.is_planned and e.status in ('allocated','paid')
  union all
  select concat_ws(':','declaration',d.id,d.document_date,d.status,d.archived_at,d.current_version,l.id,l.entity_type,l.entity_id,l.removed_at,
   (select jsonb_agg(jsonb_build_array(dl.id,dl.entity_type,dl.entity_id,dl.removed_at) order by dl.id)::text from public.document_links dl where dl.document_id=d.id))
  from public.documents d join public.document_types dt on dt.id=d.document_type_id
  join public.document_links l on l.document_id=d.id
  where dt.code='customs_declaration' and ((l.entity_type='shipment' and l.entity_id=p_shipment_id)
   or (l.entity_type='shipment_transport' and l.entity_id in(select id from public.shipment_transports where shipment_id=p_shipment_id)))
  union all
  select concat_ws(':','rate',id,base_currency_id,quote_currency_id,rate,rate_date,source,created_at) from public.exchange_rates
 ) parts
$$;
revoke all on function private.shipment_cost_inputs_digest(uuid) from public,anon,authenticated,service_role;



create or replace function public.calculate_shipment_cost(p_shipment_id uuid,p_target_currency_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;v_version integer;v_goods numeric;v_expenses numeric;v_goods_item numeric;v_exp_item numeric;r record;v_rate numeric;
 v_lost text;v_planned numeric;v_planned_without_rate integer;v_goods_allocated numeric;v_rate_date date;v_basis text;v_cost_qty numeric;v_cost_qty_basis text;
begin
 if not (select private.has_permission('costing.calculate')) then raise exception 'Нет права рассчитывать себестоимость';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 -- Hold the input set constant for the whole calculation, including concurrent INSERTs.
 -- Row locks alone cannot protect new expenses/items. These short transaction-level table
 -- locks also serialize cost versions; no external calls occur while they are held.
 lock table public.expenses, public.shipment_items, public.expense_allocations in exclusive mode;
 lock table public.documents, public.document_links, public.document_types, public.exchange_rates in share mode;
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
   -- Purchase obligations are separate from warehouse losses. Never divide the full
   -- documented purchase by only the good units received. Do not infer units from a payment amount.
   v_cost_qty:=coalesce(r.shipped_quantity,r.confirmed_quantity,r.ordered_quantity);
   v_cost_qty_basis:=case when r.shipped_quantity is not null then 'shipped' when r.confirmed_quantity is not null then 'confirmed' else 'ordered' end;
   if v_cost_qty is null or v_cost_qty<=0 then raise exception 'Укажите количество закупки для расчёта позиции %',r.internal_sku;end if;
   v_goods_item:=v_goods_allocated;v_rate:=null;v_rate_date:=null;v_basis:='expense';
  else
   v_cost_qty:=r.qty;
   v_cost_qty_basis:=case when r.received_quantity is not null then 'received'
    when r.shipped_quantity is not null then 'shipped'
    when r.confirmed_quantity is not null then 'confirmed' else 'ordered' end;
   if r.unit_price is null or r.currency_id is null then raise exception 'У позиции поставки не заполнена закупочная цена или валюта';end if;
   if r.currency_id=p_target_currency_id then
    v_rate_date:=(now() at time zone 'Asia/Almaty')::date;v_basis:='same_currency';
   else
    select d.rate_date,d.basis into v_rate_date,v_basis from private.shipment_item_rate_date(r.id) d;
   end if;
   select fr.rate into v_rate from private.finance_rate(r.currency_id,p_target_currency_id,v_rate_date) fr;
   if v_rate is null then
    raise exception 'Нет курса % → % на % для закупочной цены %: добавьте курс на эту дату или раньше',
     (select code from public.currencies where id=r.currency_id),(select code from public.currencies where id=p_target_currency_id),
     to_char(v_rate_date,'DD.MM.YYYY'),r.internal_sku;
   end if;
   v_goods_item:=round(r.qty*r.unit_price*v_rate,2);
  end if;
  insert into public.cost_calculation_items(calculation_id,shipment_item_id,product_id,quantity,goods_amount,allocated_expenses,landed_amount,unit_landed_cost,currency_id,
   goods_rate,goods_rate_date,goods_rate_basis,cost_quantity,cost_quantity_basis)
  values(v_id,r.id,r.product_id,r.qty,v_goods_item,v_exp_item,round(v_goods_item+v_exp_item,2),round((v_goods_item+v_exp_item)/v_cost_qty,4),p_target_currency_id,
   v_rate,v_rate_date,v_basis,v_cost_qty,v_cost_qty_basis);
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


