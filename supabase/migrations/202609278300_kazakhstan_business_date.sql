-- Audit 2026-10-13, finding Н10 (docs/audit-2026-10-13.md). The database runs in UTC, so between 00:00 and 05:00 in
-- Kazakhstan every "today" it computed was yesterday: actual loading and arrival dates, the year in order, letter,
-- sticker and warehouse document numbers, expiry checks of FEFO issue, the "rate date not in the future" check, and
-- the expiry check on shipping an order (which compared expiry dates with the UTC date explicitly).
-- The application shows times in Kazakhstan (UTC+5); the business day of the database follows it now.

-- 1. Every function of the application that reads current_date runs in Kazakhstan time. Only the function setting
--    changes, never a body, so the rule also holds for functions other branches redefine before this migration.
--    supabase/tests/business_date.test.sql fails for any function that reads current_date without it.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.prokind = 'f'
      and p.prosrc ~* '\mcurrent_date\M|now\(\)::date|\mlocaltimestamp\M|current_timestamp::date'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where lower(c) = 'timezone=asia/almaty')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set timezone to %L', f.signature, 'Asia/Almaty');
  end loop;
end $$;

-- 2. Shipping an order compared expiry dates with the UTC date on purpose; it uses the Kazakhstan date now.
create or replace function public.fulfill_customer_order(p_sale_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET timezone TO 'Asia/Almaty'
AS $function$
declare s public.sales; v_line record; v_balance record; v_today date; v_pct numeric;
begin
  -- An intersection of existing permissions; personal deny remains authoritative.
  if auth.uid() is null or not private.has_permission('sales.manage') or not private.has_permission('inventory.move') then
    raise exception 'Недостаточно прав для отгрузки заказа' using errcode='42501';
  end if;
  select * into s from public.sales where id=p_sale_id for update;
  if not found then raise exception 'Заказ не найден'; end if;
  -- Serializes both duplicate requests and cancellation against the whole order.
  if s.status='shipped' and s.shipped_at is not null then return s.id; end if;
  if s.status<>'confirmed' then raise exception 'Отгрузить можно только подтверждённый заказ'; end if;
  perform 1 from public.sale_items where sale_id=s.id order by id for update;
  perform 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id order by r.id for update of r;
  if not exists(select 1 from public.sale_items where sale_id=s.id) or exists(
    select 1 from public.sale_items i where i.sale_id=s.id and i.quantity<>(
      select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')
  ) or exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='fulfilled') then
    raise exception 'Заказ должен быть полностью зарезервирован';
  end if;
  -- Stable order for multiple fulfillment requests sharing balances. Balance before batch
  -- matches inventory issue operations; PostgreSQL aborts any other detected lock cycle safely.
  perform 1 from public.inventory_balances b where b.id in (
    select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='active') order by b.id for update;
  perform 1 from public.inventory_batches b where b.id in (
    select r.batch_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='active') order by b.id for update;
  perform 1 from public.guarantee_letters where sale_id=s.id order by id for update;
  -- Never accept a caller-supplied date to bypass expiry. Read the clock after lock waits.
  v_today:=(clock_timestamp() at time zone 'Asia/Almaty')::date;
  for v_balance in select b.* from public.inventory_balances b where b.id in (
    select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='active') loop
    if v_balance.quantity_reserved<>(select coalesce(sum(quantity),0) from public.inventory_reservations
      where inventory_balance_id=v_balance.id and status='active') then
      raise exception 'Остаток и действующие резервы не согласованы';
    end if;
  end loop;
  for v_line in
    select r.id, r.sale_item_id, r.batch_id, r.inventory_balance_id, r.quantity, r.uom as reservation_uom,
      i.product_id, i.required_shelf_life_pct, b.batch_id as balance_batch_id, b.warehouse_id, b.warehouse_location_id,
      b.uom as balance_uom, x.product_id as batch_product_id, x.status as batch_status, x.expiry_date, x.manufacture_date,
      p.shelf_life_days,
      -- The part of the order line from this batch, in the unit of the order, and its lowest shelf life:
      -- the same figures a guarantee letter records.
      sum(r.sale_quantity) over (partition by r.sale_item_id, r.batch_id) as batch_sale_quantity,
      min(r.remaining_shelf_life_pct) over (partition by r.sale_item_id, r.batch_id) as batch_shelf_life_pct
    from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    join public.inventory_balances b on b.id=r.inventory_balance_id join public.inventory_batches x on x.id=r.batch_id
    join public.products p on p.id=i.product_id where i.sale_id=s.id and r.status='active' order by r.id
  loop
    if v_line.batch_id<>v_line.balance_batch_id or v_line.product_id<>v_line.batch_product_id or v_line.warehouse_id<>s.warehouse_id
       or v_line.reservation_uom<>v_line.balance_uom then
      raise exception 'Резерв не соответствует товару, складу или единице остатка';
    end if;
    if v_line.batch_status<>'available' or v_line.expiry_date<v_today then
      raise exception 'Партия заблокирована, в карантине или просрочена';
    end if;
    v_pct:=private.sale_shelf_life_pct(v_line.expiry_date,v_line.manufacture_date,v_line.shelf_life_days,greatest(v_today,s.planned_shipment_date));
    if v_line.required_shelf_life_pct is not null and v_pct<v_line.required_shelf_life_pct and not exists(
      select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
      where g.sale_id=s.id and g.status in ('approved','sent','accepted') and gi.sale_item_id=v_line.sale_item_id
        and gi.batch_id=v_line.batch_id and gi.quantity=v_line.batch_sale_quantity and gi.required_shelf_life_pct=v_line.required_shelf_life_pct
        and gi.remaining_shelf_life_pct=v_line.batch_shelf_life_pct and v_pct>=gi.remaining_shelf_life_pct
    ) then raise exception 'ОСГ требует действующего гарантийного письма на текущие партии и срок'; end if;
    update public.inventory_balances set quantity_on_hand=quantity_on_hand-v_line.quantity,
      quantity_reserved=quantity_reserved-v_line.quantity,updated_at=now()
      where id=v_line.inventory_balance_id and quantity_on_hand>=v_line.quantity and quantity_reserved>=v_line.quantity;
    if not found then raise exception 'Недостаточный остаток или резерв для отгрузки'; end if;
    insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,
      reference,reason,sale_id,sale_item_id,inventory_reservation_id)
    values(v_line.batch_id,'issue',v_line.quantity,v_line.reservation_uom,v_line.warehouse_id,v_line.warehouse_location_id,
      s.sale_number,'Отгрузка подтверждённого заказа',s.id,v_line.sale_item_id,v_line.id);
    update public.inventory_reservations set status='fulfilled',updated_at=now() where id=v_line.id;
  end loop;
  update public.inventory_batches x set status='depleted',updated_at=now()
    where x.id in (select r.batch_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id)
      and x.status='available' and not exists(select 1 from public.inventory_balances b where b.batch_id=x.id and b.quantity_on_hand>0);
  update public.sales set status='shipped',shipped_at=clock_timestamp(),shipped_by=auth.uid(),updated_at=now() where id=s.id;
  return s.id;
end $function$;

-- 3. The stock view computes days left, shelf-life state and FEFO order for the Kazakhstan date.
create or replace view public.inventory_fifo_status with (security_invoker = true) as
select balance.id as balance_id,
  batch.id as batch_id,
  batch.batch_number,
  batch.manufacture_date,
  batch.expiry_date,
  batch.received_at,
  batch.status as batch_status,
  batch.status_reason,
  batch.status_changed_at,
  product.id as product_id,
  product.internal_sku,
  product.name as product_name,
  product.brand,
  warehouse.id as warehouse_id,
  warehouse.code as warehouse_code,
  warehouse.name as warehouse_name,
  location.id as location_id,
  location.code as location_code,
  balance.uom,
  balance.quantity_on_hand,
  balance.quantity_reserved,
  balance.quantity_on_hand - balance.quantity_reserved as quantity_available,
  batch.expiry_date - business.today as days_remaining,
  case when batch.manufacture_date is null then null::numeric
    else round(least(100::numeric, greatest(0::numeric, 100::numeric * (batch.expiry_date - business.today)::numeric
      / greatest(1, batch.expiry_date - batch.manufacture_date)::numeric)), 1) end as shelf_life_percent,
  case when batch.status in ('quarantine','blocked') then batch.status
    when batch.expiry_date < business.today then 'expired'
    when batch.expiry_date <= business.today + 30 then 'critical'
    when batch.expiry_date <= business.today + 90 then 'warning'
    else 'normal' end as shelf_life_state,
  case when batch.status = 'available' and batch.expiry_date >= business.today and balance.quantity_on_hand > balance.quantity_reserved
    then sum(case when batch.status = 'available' and batch.expiry_date >= business.today and balance.quantity_on_hand > balance.quantity_reserved then 1 else 0 end)
      over (partition by product.id, warehouse.id, balance.uom order by batch.expiry_date, batch.received_at, batch.id)
    else null::bigint end as fifo_rank
from public.inventory_balances balance
join public.inventory_batches batch on batch.id = balance.batch_id
join public.products product on product.id = batch.product_id
join public.warehouses warehouse on warehouse.id = balance.warehouse_id
left join public.warehouse_locations location on location.id = balance.warehouse_location_id
cross join lateral (select (now() at time zone 'Asia/Almaty')::date as today) business
where balance.quantity_on_hand > 0;

-- 4. Dates filled in by default.
alter table public.sales alter column sale_date set default ((now() at time zone 'Asia/Almaty')::date);
alter table public.inventory_operation_documents alter column document_date set default ((now() at time zone 'Asia/Almaty')::date);
