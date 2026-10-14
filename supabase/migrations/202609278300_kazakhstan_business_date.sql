-- Audit 2026-10-13, finding Н10 (docs/audit-2026-10-13.md). The database runs in UTC, so between 00:00 and 05:00 in
-- Kazakhstan every "today" it computed was yesterday. 202609278100 moved sales and shipping of orders to
-- private.business_today(). This migration covers the rest: actual arrival dates on receipt, the year in shipment,
-- sticker, marking and return numbers, the dates of warehouse documents and generated packages, the expiry check of
-- FEFO issue, the "rate date not in the future" check, the rate date of costing, and the stock view.

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

-- 2. The stock view computes days left, shelf-life state and FEFO order for the Kazakhstan date.
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

-- 3. Dates filled in by default.
alter table public.sales alter column sale_date set default ((now() at time zone 'Asia/Almaty')::date);
alter table public.inventory_operation_documents alter column document_date set default ((now() at time zone 'Asia/Almaty')::date);
