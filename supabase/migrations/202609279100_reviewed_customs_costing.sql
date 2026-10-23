-- Owner decision: purchase FX uses the approved customs declaration date. PR 36 is excluded.
begin;
insert into public.document_types(code,name_ru,name_en,name_kk,category,sort_order)
values('customs_declaration','Таможенная декларация','Customs declaration','Кедендік декларация','customs',81)
on conflict(code) do nothing;
alter table public.cost_calculation_items drop constraint if exists cost_calculation_items_goods_rate_basis_check;
alter table public.cost_calculation_items add constraint cost_calculation_items_goods_rate_basis_check
 check(goods_rate_basis in ('expense','receipt','loading','calculation','customs_declaration','same_currency'));
create or replace function private.shipment_item_rate_date(p_shipment_item_id uuid)
returns table(rate_date date, basis text) language plpgsql stable security definer set search_path='' as $$
declare v_shipment uuid;v_transport uuid;v_days date[];
begin
 select shipment_id,shipment_transport_id into v_shipment,v_transport from public.shipment_items where id=p_shipment_item_id;
 -- A declaration linked to this vehicle is more specific than a shipment-wide declaration.
 with candidates as (
  select distinct d.id,d.document_date,case when l.entity_type='shipment_transport' then 0 else 1 end priority
  from public.documents d join public.document_types dt on dt.id=d.document_type_id
  join public.document_links l on l.document_id=d.id and l.removed_at is null
  where dt.code='customs_declaration' and d.status='approved' and d.archived_at is null and d.document_date is not null
   and ((l.entity_type='shipment_transport' and l.entity_id=v_transport)
    or (l.entity_type='shipment' and l.entity_id=v_shipment and not exists(
      select 1 from public.document_links other where other.document_id=d.id and other.entity_type='shipment_transport' and other.removed_at is null)))
 ) select array_agg(distinct document_date) into v_days from candidates where priority=(select min(priority) from candidates);
 if cardinality(v_days)>1 then raise exception 'Для позиции указаны таможенные декларации с разными датами: уточните привязки документов';end if;
 if cardinality(v_days)=1 then
  if v_days[1]>(now() at time zone 'Asia/Almaty')::date then raise exception 'Дата таможенной декларации не может быть в будущем';end if;
  return query select v_days[1],'customs_declaration'::text;return;
 end if;
 return query select (now() at time zone 'Asia/Almaty')::date,'calculation'::text;
end $$;
revoke all on function private.shipment_item_rate_date(uuid) from public,anon,authenticated,service_role;

create or replace function private.shipment_cost_inputs_digest(p_shipment_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select md5(coalesce(string_agg(part,'|' order by part),'')) from (
  select concat_ws(':','item',i.id,coalesce(coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)::text,'-'),
   coalesce(i.unit_price::text,'-'),coalesce(i.currency_id::text,'-'),coalesce(i.shipment_transport_id::text,'-')) part
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
 v_lost text;v_planned numeric;v_planned_without_rate integer;v_goods_allocated numeric;v_rate_date date;v_basis text;
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
   v_goods_item:=v_goods_allocated;v_rate:=null;v_rate_date:=null;v_basis:='expense';
  else
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


create or replace function public.approve_shipment_cost(p_calculation_id uuid)
returns void language plpgsql security definer set search_path='' as $$declare c record;begin
 if not (select private.has_permission('costing.approve')) then raise exception 'Нет права утверждать себестоимость';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 lock table public.expenses, public.shipment_items, public.expense_allocations in exclusive mode;
 lock table public.documents, public.document_links, public.document_types, public.exchange_rates in share mode;
 select * into c from public.cost_calculations where id=p_calculation_id and status='draft' for update;if not found then raise exception 'Расчёт не найден или уже утверждён';end if;
 if c.inputs_digest is null then raise exception 'Расчёт сделан по прежним правилам: рассчитайте новую версию';end if;
 -- Table locks protect both existing rows and new inputs until approval commits.
 -- Do not take expense row locks here: writers can already own them while waiting
 -- for the table lock, which would invert the locking order.
 if c.inputs_digest<>private.shipment_cost_inputs_digest(c.shipment_id) then
  raise exception 'После расчёта изменились расходы или позиции поставки, декларация или курсы: рассчитайте новую версию';end if;
 if exists(select 1 from public.cost_calculation_items where calculation_id=c.id and goods_rate_basis='calculation') then
  raise exception 'Расчёт предварительный: подтвердите таможенную декларацию с датой и рассчитайте новую версию';end if;
 update public.cost_calculations set status='superseded' where shipment_id=c.shipment_id and status='approved';
 update public.cost_calculations set status='approved',approved_by=auth.uid(),approved_at=now() where id=c.id;
 update public.inventory_batches b set unit_landed_cost=i.unit_landed_cost,cost_currency_id=i.currency_id,cost_calculation_id=c.id,updated_at=now() from public.cost_calculation_items i where i.calculation_id=c.id and i.shipment_item_id=b.source_shipment_item_id;
end $$;


create or replace function private.customer_order_blockers(p_sale_id uuid, p_on_date date default null)
returns table(code text, message text, sale_item_id uuid, batch_id uuid)
language plpgsql security definer set search_path='' as $$
declare s public.sales; v_today date; v_ship date; v_expiry_day date; v_line record; v_pct numeric;
begin
  select * into s from public.sales where id=p_sale_id;
  if not found then raise exception 'Заказ не найден'; end if;
  if s.status<>'confirmed' then return; end if;
  v_today:=private.business_today();
  -- A new planned date (rescheduling) is checked as confirmation checks it: the batch has to last until then.
  v_ship:=greatest(v_today,coalesce(p_on_date,s.planned_shipment_date));
  v_expiry_day:=case when p_on_date is null then v_today else v_ship end;

  if not exists(select 1 from public.sale_items where sale_id=s.id) then
    return query select 'no_items'::text,'В заказе нет товаров'::text,null::uuid,null::uuid;
  end if;
  return query
    select 'not_reserved'::text,
      format('%s: зарезервировано %s из %s',p.internal_sku,
        rtrim(to_char(coalesce(sum(r.sale_quantity) filter (where r.status='active'),0),'FM999999999990.999'),'.'),
        rtrim(to_char(i.quantity,'FM999999999990.999'),'.')),
      i.id,null::uuid
    from public.sale_items i join public.products p on p.id=i.product_id
    left join public.inventory_reservations r on r.sale_item_id=i.id
    where i.sale_id=s.id
    group by i.id,i.quantity,p.internal_sku
    having i.quantity<>coalesce(sum(r.sale_quantity) filter (where r.status='active'),0)
        or bool_or(r.status='fulfilled');

  for v_line in
    select distinct on (r.sale_item_id,r.batch_id)
      r.sale_item_id,r.batch_id,i.required_shelf_life_pct,p.internal_sku,x.batch_number,x.status batch_status,x.status_reason,
      x.expiry_date,x.manufacture_date,p.shelf_life_days,
      bool_or(r.batch_id<>b.batch_id or i.product_id<>x.product_id or b.warehouse_id<>s.warehouse_id or r.uom<>b.uom)
        over (partition by r.sale_item_id,r.batch_id) mismatch,
      sum(r.sale_quantity) over (partition by r.sale_item_id,r.batch_id) batch_sale_quantity,
      min(r.remaining_shelf_life_pct) over (partition by r.sale_item_id,r.batch_id) batch_shelf_life_pct
    from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    join public.inventory_balances b on b.id=r.inventory_balance_id join public.inventory_batches x on x.id=r.batch_id
    join public.products p on p.id=i.product_id
    where i.sale_id=s.id and r.status='active'
    order by r.sale_item_id,r.batch_id
  loop
    if v_line.mismatch then
      return query select 'reservation_mismatch'::text,
        format('%s, партия %s: резерв не соответствует товару, складу или единице остатка',v_line.internal_sku,v_line.batch_number),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    if v_line.batch_status<>'available' then
      return query select 'batch_unavailable'::text,
        format('%s, партия %s: %s%s',v_line.internal_sku,v_line.batch_number,
          case v_line.batch_status when 'blocked' then 'заблокирована' when 'quarantine' then 'в карантине'
            when 'depleted' then 'израсходована' else v_line.batch_status end,
          coalesce(' — '||nullif(trim(v_line.status_reason),''),'')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    if v_line.expiry_date<v_expiry_day then
      return query select 'batch_expired'::text,
        format(case when v_line.expiry_date<v_today then '%s, партия %s: просрочена (годна до %s)' else '%s, партия %s: истечёт до отгрузки (годна до %s)' end,v_line.internal_sku,v_line.batch_number,to_char(v_line.expiry_date,'DD.MM.YYYY')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    -- A batch on hold or expired has to be replaced anyway; its shelf life adds nothing to say.
    if v_line.batch_status<>'available' or v_line.expiry_date<v_expiry_day then continue; end if;
    v_pct:=private.sale_shelf_life_pct(v_line.expiry_date,v_line.manufacture_date,v_line.shelf_life_days,v_ship);
    if v_line.required_shelf_life_pct is not null and v_pct<v_line.required_shelf_life_pct and not exists(
      select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
      where g.sale_id=s.id and g.status in ('approved','sent','accepted') and gi.sale_item_id=v_line.sale_item_id
        and gi.batch_id=v_line.batch_id and gi.quantity=v_line.batch_sale_quantity and gi.required_shelf_life_pct=v_line.required_shelf_life_pct
        and gi.remaining_shelf_life_pct=v_line.batch_shelf_life_pct and v_pct>=gi.remaining_shelf_life_pct
    ) then
      return query select 'shelf_life_letter'::text,
        format('%s, партия %s: остаточный срок %s%% ниже требуемых %s%% — нужно действующее гарантийное письмо на эту партию и количество',
          v_line.internal_sku,v_line.batch_number,rtrim(to_char(v_pct,'FM990.99'),'.'),rtrim(to_char(v_line.required_shelf_life_pct,'FM990.99'),'.')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
  end loop;

  return query
    select distinct 'stock_mismatch'::text,
      format('Партия %s: остаток или резервы на складе не сходятся с резервами заказов',x.batch_number),
      null::uuid,b.batch_id
    from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id
    where b.id in (select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
                   where i.sale_id=s.id and r.status='active')
      and (b.quantity_reserved<>(select coalesce(sum(q.quantity),0) from public.inventory_reservations q
                                 where q.inventory_balance_id=b.id and q.status='active')
        or b.quantity_on_hand<(select coalesce(sum(q.quantity),0) from public.inventory_reservations q join public.sale_items qi on qi.id=q.sale_item_id
                               where q.inventory_balance_id=b.id and q.status='active' and qi.sale_id=s.id));
end $$;
revoke all on function public.approve_shipment_cost(uuid) from public,anon,authenticated,service_role;
grant execute on function public.approve_shipment_cost(uuid) to authenticated;
commit;
