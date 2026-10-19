-- Explicit preview -> reviewed allocation -> atomic replacement. No stock movements.
create table if not exists public.sale_reservation_replacements (
 id uuid primary key,
 sale_id uuid not null references public.sales(id),
 created_by uuid not null references public.profiles(id),
 created_at timestamptz not null default clock_timestamp(),
 reason text not null check(length(btrim(reason)) between 1 and 500),
 request jsonb not null,
 previous_allocation jsonb not null,
 new_allocation jsonb not null
);
alter table public.sale_reservation_replacements enable row level security;
revoke all on public.sale_reservation_replacements from public,anon,authenticated,service_role;
grant select on public.sale_reservation_replacements to authenticated;
drop policy if exists "employees view reservation replacements" on public.sale_reservation_replacements;
create policy "employees view reservation replacements" on public.sale_reservation_replacements for select to authenticated
 using (private.has_permission('sales.view') and private.has_permission('inventory.view') and private.has_permission('products.view'));
create index if not exists sale_reservation_replacements_sale_idx on public.sale_reservation_replacements(sale_id,created_at desc);

create or replace function private.require_reservation_replacement_access() returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not (private.has_permission('sales.view') and private.has_permission('sales.manage')
  and private.has_permission('sales.reserve') and private.has_permission('sales.override_fefo')
  and private.has_permission('inventory.view') and private.has_permission('products.view')) then
  raise exception 'Недостаточно прав для просмотра и замены резервов' using errcode='42501';
 end if;
end $$;

-- One SQL snapshot, explicit safe columns only. No prices, costs, customer details or letter text.
-- Aggregate rather than paginated API rows: a truncated selection must never look complete.
create or replace function private.reservation_replacement_snapshot(p_sale_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'order',jsonb_build_object('id',s.id,'status',s.status,'warehouse_id',s.warehouse_id,'date',s.planned_shipment_date,'today',private.business_today()),
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'product_id',i.product_id,'sku',p.internal_sku,
    'quantity',i.quantity,'uom',i.uom,'required_pct',i.required_shelf_life_pct,'shelf_life_days',p.shelf_life_days) order by i.id)
    from public.sale_items i join public.products p on p.id=i.product_id where i.sale_id=s.id),'[]'),
  'reservations',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'item_id',r.sale_item_id,'balance_id',r.inventory_balance_id,
    'batch_id',r.batch_id,'batch_number',b.batch_number,'quantity',r.quantity,'uom',r.uom,'sale_quantity',r.sale_quantity,
    'pct',r.remaining_shelf_life_pct) order by r.id) from public.inventory_reservations r
    join public.sale_items i on i.id=r.sale_item_id join public.inventory_batches b on b.id=r.batch_id
    where i.sale_id=s.id and r.status='active'),'[]'),
  'balances',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'batch_id',b.batch_id,'product_id',x.product_id,
    'batch_number',x.batch_number,'status',x.status,'expiry',x.expiry_date,'manufactured',x.manufacture_date,
    'received_at',x.received_at,'uom',b.uom,'on_hand',b.quantity_on_hand,'reserved',b.quantity_reserved,
    'free',b.quantity_on_hand-b.quantity_reserved,'warehouse_id',b.warehouse_id,
    'pct',private.sale_shelf_life_pct(x.expiry_date,x.manufacture_date,p.shelf_life_days,greatest(s.planned_shipment_date,private.business_today())))
    order by x.expiry_date,x.received_at,x.id,b.id)
    from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id join public.products p on p.id=x.product_id
    where b.warehouse_id=s.warehouse_id and exists(select 1 from public.sale_items i where i.sale_id=s.id and i.product_id=x.product_id)),'[]'),
  'packaging',coalesce((select jsonb_agg(jsonb_build_object('product_id',p.product_id,'uom',p.uom,'units',p.units_per_parent) order by p.product_id,p.uom)
    from public.product_packaging p where exists(select 1 from public.sale_items i where i.sale_id=s.id and i.product_id=p.product_id)),'[]'),
  -- A change stamp only: no guarantee contents are disclosed without their own read scope.
  'letters_stamp',md5(coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'status',g.status,'updated',g.updated_at,
    'items',(select jsonb_agg(to_jsonb(gi) order by gi.id) from public.guarantee_letter_items gi where gi.guarantee_letter_id=g.id)) order by g.id)::text
    from public.guarantee_letters g where g.sale_id=s.id),'[]')))
 from public.sales s where s.id=p_sale_id
$$;

-- Validate a whole selected line, potentially split over several balances. Both preview and write use this.
create or replace function private.reservation_replacement_plan(p_sale_id uuid,p_allocations jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sales; allocation record; i public.sale_items; b record; q numeric; pct numeric;
 result jsonb:='[]'; line record;
begin
 select * into s from public.sales where id=p_sale_id;
 if s.status is distinct from 'confirmed' then raise exception 'Заменять партии можно только в подтверждённом неотгруженном заказе';end if;
 if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations) not between 1 and 500 then
  raise exception 'Выберите от 1 до 500 распределений';end if;
 if exists(select 1 from jsonb_array_elements(p_allocations) a where jsonb_typeof(a) is distinct from 'object'
  or jsonb_typeof(a->'sale_quantity') is distinct from 'number' or a->>'item_id' is null or a->>'balance_id' is null) then
  raise exception 'Некорректное распределение';end if;
 if exists(select 1 from jsonb_array_elements(p_allocations) a group by a->>'item_id',a->>'balance_id' having count(*)>1) then
  raise exception 'Одна партия остатка указана для позиции несколько раз';end if;
 for allocation in select * from jsonb_to_recordset(p_allocations) as x(item_id uuid,balance_id uuid,sale_quantity numeric) loop
  select * into i from public.sale_items where id=allocation.item_id and sale_id=s.id;
  if not found then raise exception 'Позиция не относится к этому заказу';end if;
  if allocation.sale_quantity is null or allocation.sale_quantity<=0 or allocation.sale_quantity<>round(allocation.sale_quantity,3) then
   raise exception 'Количество должно быть положительным с точностью до 0,001';end if;
  select balance.*,batch.product_id,batch.status,batch.expiry_date,batch.manufacture_date,batch.batch_number,p.shelf_life_days
   into b from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id
   join public.products p on p.id=batch.product_id where balance.id=allocation.balance_id;
  if not found or b.product_id<>i.product_id or b.warehouse_id<>s.warehouse_id then
   raise exception 'Выбранный остаток не соответствует товару или складу заказа';end if;
  if b.status<>'available' then raise exception 'Выбранная партия заблокирована или в карантине. Обновите варианты';end if;
  if b.expiry_date<greatest(s.planned_shipment_date,private.business_today()) then raise exception 'Выбранная партия просрочена на дату отгрузки. Обновите варианты';end if;
  q:=private.convert_uom(i.product_id,allocation.sale_quantity,i.uom,b.uom);
  if q is null or q<=0 or q<>round(q,3) then raise exception 'Упаковка отсутствует или количество не пересчитывается точно до 0,001';end if;
  pct:=private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,b.shelf_life_days,greatest(s.planned_shipment_date,private.business_today()));
  result:=result||jsonb_build_array(jsonb_build_object('item_id',i.id,'sku',(select internal_sku from public.products where id=i.product_id),
   'balance_id',b.id,'batch_id',b.batch_id,'batch_number',b.batch_number,'sale_quantity',allocation.sale_quantity,'sale_uom',i.uom,
   'quantity',q,'uom',b.uom,'pct',pct,'required_pct',i.required_shelf_life_pct));
 end loop;
 for line in select item_id,sum(sale_quantity) as qty from jsonb_to_recordset(result) as x(item_id uuid,sale_quantity numeric) group by item_id loop
  if line.qty<>(select quantity from public.sale_items where id=line.item_id) then raise exception 'Каждая выбранная позиция должна быть покрыта полностью';end if;
 end loop;
 for line in select balance_id,sum(quantity) as qty from jsonb_to_recordset(result) as x(balance_id uuid,quantity numeric) group by balance_id loop
  select * into b from public.inventory_balances where id=line.balance_id;
  if line.qty>b.quantity_on_hand-b.quantity_reserved+coalesce((select sum(r.quantity) from public.inventory_reservations r
    where r.inventory_balance_id=b.id and r.status='active' and r.sale_item_id in
    (select (a->>'item_id')::uuid from jsonb_array_elements(result) a)),0) then
   raise exception 'Недостаточный свободный остаток выбранной партии. Обновите варианты';end if;
 end loop;
 -- Same exact line/batch/quantity/OSG binding as confirm_customer_order. Never transfer a letter to a new batch.
 for line in select x.item_id,x.batch_id,sum(x.sale_quantity) as qty,min(x.pct) as pct,max(x.required_pct) as required
  from jsonb_to_recordset(result) as x(item_id uuid,batch_id uuid,sale_quantity numeric,pct numeric,required_pct numeric)
  group by item_id,batch_id loop
  if line.required is not null and line.pct<line.required and not exists(
   select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
   where g.sale_id=s.id and g.status in ('approved','sent','accepted') and gi.sale_item_id=line.item_id and gi.batch_id=line.batch_id
    and gi.quantity=line.qty and gi.remaining_shelf_life_pct=line.pct and gi.required_shelf_life_pct=line.required) then
   raise exception 'ОСГ новой партии требует отдельного утверждённого письма на эту позицию, партию и количество. Используйте возврат к подготовке';
  end if;
 end loop;
 return result;
end $$;

create or replace function public.preview_customer_order_reservation_replacement(p_sale_id uuid,p_allocations jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare snap jsonb; plan jsonb;
begin
 perform private.require_reservation_replacement_access();
 -- Read-only preview. Concurrent edits may invalidate it; the writer always rechecks after locking.
 snap:=private.reservation_replacement_snapshot(p_sale_id);
 if snap is null or snap#>>'{order,status}'<>'confirmed' then raise exception 'Заказ недоступен для замены резервов';end if;
 if jsonb_array_length(snap->'items')>100 or jsonb_array_length(snap->'balances')>2000 then
  raise exception 'Слишком большой набор вариантов: предварительный просмотр не выполнен';end if;
 if p_allocations is not null then plan:=private.reservation_replacement_plan(p_sale_id,p_allocations);end if;
 return jsonb_build_object('snapshot',snap,'plan',plan);
end $$;

create or replace function public.replace_customer_order_reservations(p_sale_id uuid,p_request_id uuid,p_expected jsonb,p_allocations jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.sales; prev public.sale_reservation_replacements; snap jsonb; plan jsonb; line record; k text;
 request jsonb:=jsonb_build_object('expected',p_expected,'allocations',p_allocations,'reason',btrim(p_reason));
begin
 perform private.require_reservation_replacement_access();
 if p_request_id is null or nullif(btrim(p_reason),'') is null or length(btrim(p_reason))>500 then raise exception 'Укажите идентификатор запроса и причину от 1 до 500 символов';end if;
 -- Order -> items -> reservations -> balances(UUID) -> batches(UUID) -> products/packaging -> letters.
 -- Same prefix as fulfillment. Two orders always take shared stock in the same UUID order.
 select * into s from public.sales where id=p_sale_id for update;
 if not found then raise exception 'Заказ недоступен';end if;
 perform private.require_reservation_replacement_access();
 select * into prev from public.sale_reservation_replacements where id=p_request_id;
 if found then
  if prev.sale_id<>p_sale_id or prev.created_by<>auth.uid() or prev.request<>request then raise exception 'Идентификатор запроса уже использован с другими данными';end if;
  return prev.id; -- Acknowledges the original operation, even after shipment/cancellation; performs no new write.
 end if;
 if s.status<>'confirmed' then raise exception 'Состояние заказа изменилось. Заменять можно только подтверждённый заказ';end if;
 if exists(select 1 from public.inventory_movements where sale_id=s.id and movement_type='issue') then raise exception 'По заказу уже есть отгрузка';end if;
 perform 1 from public.sale_items where sale_id=s.id order by id for update;
 perform 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id order by r.id for update of r;
 perform 1 from public.inventory_balances b where (b.warehouse_id=s.warehouse_id and exists(
  select 1 from public.inventory_batches x join public.sale_items i on i.product_id=x.product_id where x.id=b.batch_id and i.sale_id=s.id))
  or b.id in(select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id and r.status='active')
  order by b.id for update;
 perform 1 from public.inventory_batches b where exists(select 1 from public.sale_items i where i.sale_id=s.id and i.product_id=b.product_id) order by b.id for share;
 perform 1 from public.products p where exists(select 1 from public.sale_items i where i.sale_id=s.id and i.product_id=p.id) order by p.id for share;
 perform 1 from public.product_packaging p where exists(select 1 from public.sale_items i where i.sale_id=s.id and i.product_id=p.product_id) order by p.id for share;
 perform 1 from public.guarantee_letters where sale_id=s.id order by id for update;
 perform 1 from public.guarantee_letter_items gi join public.guarantee_letters g on g.id=gi.guarantee_letter_id where g.sale_id=s.id order by gi.id for share of gi;
 perform private.require_reservation_replacement_access();
 plan:=private.reservation_replacement_plan(s.id,p_allocations);
 snap:=private.reservation_replacement_snapshot(s.id);
 if p_expected is null then raise exception 'Сначала проверьте распределение';end if;
 foreach k in array array['order','items','reservations','balances','packaging','letters_stamp'] loop
  if snap->k is distinct from p_expected->k then
   raise exception '%',case k
    when 'order' then 'Дата или состояние заказа изменились. Обновите варианты'
    when 'items' then 'Позиции или требования ОСГ изменились. Обновите варианты'
    when 'reservations' then 'Резервы заказа изменены другим сотрудником. Обновите варианты'
    when 'balances' then 'Остаток или состояние партий изменились. Обновите варианты'
    when 'packaging' then 'Упаковка товара изменилась. Обновите варианты'
    else 'Гарантийные письма изменились. Обновите варианты' end;
  end if;
 end loop;
 if exists(select 1 from public.inventory_balances b where b.id in(
  select (a->>'balance_id')::uuid from jsonb_array_elements(plan) a union
  select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id and r.status='active')
  and b.quantity_reserved<>(select coalesce(sum(r.quantity),0) from public.inventory_reservations r where r.inventory_balance_id=b.id and r.status='active')) then
  raise exception 'Остаток и действующие резервы не согласованы';end if;
 for line in select distinct (a->>'item_id')::uuid as id from jsonb_array_elements(plan) a order by id loop
  perform private.release_sale_item_reservations(line.id);
 end loop;
 for line in select * from jsonb_to_recordset(plan) as x(item_id uuid,balance_id uuid,batch_id uuid,quantity numeric,uom text,sale_quantity numeric,pct numeric) loop
  update public.inventory_balances set quantity_reserved=quantity_reserved+line.quantity,updated_at=now()
   where id=line.balance_id and quantity_on_hand-quantity_reserved>=line.quantity;
  if not found then raise exception 'Недостаточный свободный остаток. Обновите варианты';end if;
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct,is_fefo_override,override_reason,override_approved_by)
   values(line.item_id,line.balance_id,line.batch_id,line.quantity,line.uom,line.sale_quantity,line.pct,true,btrim(p_reason),auth.uid());
 end loop;
 if not exists(select 1 from public.sale_items where sale_id=s.id) or exists(select 1 from public.sale_items i where i.sale_id=s.id
  and i.quantity<>(select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')) then
  raise exception 'Заказ должен быть полностью зарезервирован';end if;
 -- Reuse the existing confirmation operation, including current shelf-life and exact guarantee binding.
 -- No call to recovery: it would cancel letters for untouched positions. No second recovery workflow.
 update public.sales set status='reserved' where id=s.id;
 perform public.confirm_customer_order(s.id);
 -- Preserve original confirmation authorship; this separate immutable event records the replacement author.
 update public.sales set confirmed_at=s.confirmed_at,confirmed_by=s.confirmed_by where id=s.id;
 insert into public.sale_reservation_replacements(id,sale_id,created_by,reason,request,previous_allocation,new_allocation)
 values(p_request_id,s.id,auth.uid(),btrim(p_reason),request,snap->'reservations',plan);
 return p_request_id;
end $$;

revoke all on function private.require_reservation_replacement_access(),private.reservation_replacement_snapshot(uuid),
 private.reservation_replacement_plan(uuid,jsonb),public.preview_customer_order_reservation_replacement(uuid,jsonb),
 public.replace_customer_order_reservations(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.preview_customer_order_reservation_replacement(uuid,jsonb),public.replace_customer_order_reservations(uuid,uuid,jsonb,jsonb,text) to authenticated;
