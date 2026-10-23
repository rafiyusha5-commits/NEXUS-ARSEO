-- Audit finding Н10: the business day of the database is Kazakhstan's (202609278300), whatever the session time zone.
-- The checks run in two session time zones, UTC−12 and UTC+14: at any moment at least one of them is on a different
-- date than Kazakhstan, so a function that still followed the session would be caught at any time of day.
-- supabase/tests/before/202609278300_kazakhstan_business_date.sql shows the defect before the fix.
\set ON_ERROR_STOP 1
begin;

-- 1. The rule for every function, present and future: reading current_date requires the Kazakhstan time zone.
do $$
declare v_missing text; v_utc text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v_missing
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.prokind = 'f' and p.prosrc ~* '\mcurrent_date\M|now\(\)::date|\mlocaltimestamp\M|current_timestamp::date'
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where lower(c) = 'timezone=asia/almaty')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');
  assert v_missing is null, format('Н10: these functions read the current date in the session time zone (UTC): %s. '
    'Add "set timezone to ''Asia/Almaty''" to them (see 202609278300_kazakhstan_business_date.sql)', v_missing);
  select string_agg(p.oid::regprocedure::text, ', ') into v_utc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.prosrc ~* 'at time zone ''UTC''\)::date';
  assert v_utc is null, format('Н10: these functions take a business date in UTC: %s', v_utc);
  assert pg_get_viewdef('public.inventory_fifo_status'::regclass) !~* 'current_date', 'the stock view uses the Kazakhstan date';
  assert (select bool_and(column_default like '%Asia/Almaty%') from information_schema.columns
    where table_schema = 'public' and (table_name, column_name) in (('sales','sale_date'),('inventory_operation_documents','document_date'))),
    'default dates are Kazakhstan dates';
end $$;

-- 2. The same calls in two far-apart session time zones give the Kazakhstan date.
insert into auth.users(id,email,raw_user_meta_data) values
 ('b0d00000-0000-4000-8000-000000000001','date-director@test.local','{"full_name":"Date Director"}');
insert into public.user_roles(user_id,role_id) select 'b0d00000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b0d10000-0000-4000-8000-000000000001',array['customer'],'Date buyer','KZ','DT-C'),
 ('b0d10000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'Date factory','FI','DT-M');
insert into public.warehouses(id,code,name,city,country) values
 ('b0d20000-0000-4000-8000-000000000001','DT-WH','{"ru":"Склад дат"}','Актобе','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,shelf_life_days) values
 ('b0d30000-0000-4000-8000-000000000001','DT-001','{"ru":"Товар с датами"}','b0d10000-0000-4000-8000-000000000002',200);
create temporary table kz as select (now() at time zone 'Asia/Almaty')::date as today;
-- Expired yesterday, expires today and a fresh batch, in Kazakhstan dates.
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by)
select b.id::uuid,'b0d30000-0000-4000-8000-000000000001',b.number,kz.today-100,kz.today+b.shift,'b0d00000-0000-4000-8000-000000000001'
from kz cross join (values('b0d40000-0000-4000-8000-000000000001','DT-YESTERDAY',-1),('b0d40000-0000-4000-8000-000000000002','DT-TODAY',0),
 ('b0d40000-0000-4000-8000-000000000003','DT-FRESH',100))b(id,number,shift);
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand)
select id,'b0d20000-0000-4000-8000-000000000001','piece',10 from public.inventory_batches where batch_number like 'DT-%';
create temporary table dt(zone text,sale_id uuid,issued text,fifo text,rate_ok boolean);
grant all on dt to authenticated;
grant select on kz to authenticated;

create function pg_temp.check_zone(p_zone text) returns void language plpgsql as $$
declare v_sale uuid; v_issued text; v_fifo text; v_rate boolean := true;
begin
  perform set_config('timezone', p_zone, true);
  v_sale := public.create_customer_order('b0d10000-0000-4000-8000-000000000001',null,'b0d20000-0000-4000-8000-000000000001',(select today from kz)+30,null,p_zone);
  -- FEFO issue takes the batch that expires today in Kazakhstan, never the one that expired yesterday.
  select string_agg(a->>'batch_number', ',') into v_issued
  from jsonb_array_elements(to_jsonb(public.issue_inventory_fifo('b0d30000-0000-4000-8000-000000000001','b0d20000-0000-4000-8000-000000000001','piece',1::numeric,'DT','Проверка даты'))) a;
  select string_agg(batch_number||'='||shelf_life_state||'/'||days_remaining, ',' order by batch_number) into v_fifo
  from public.inventory_fifo_status where product_id='b0d30000-0000-4000-8000-000000000001';
  -- A rate dated today in Kazakhstan is not in the future.
  begin
    perform public.add_exchange_rate((select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),
      500,case when p_zone like 'Etc/%' then 'official' else 'bank' end,'Проверка',(select today from kz));
  exception when others then v_rate := false;
  end;
  insert into dt values(p_zone,v_sale,v_issued,v_fifo,v_rate);
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','b0d00000-0000-4000-8000-000000000001',false);
select pg_temp.check_zone('Etc/GMT+12');
select pg_temp.check_zone('Pacific/Kiritimati');
reset role;
set local timezone='UTC';
do $$begin
 assert (select count(*)=2 and bool_and(s.sale_date=kz.today) from dt join public.sales s on s.id=dt.sale_id cross join kz),
  'the order date is the Kazakhstan date in both session time zones';
 assert (select bool_and(issued='DT-TODAY') from dt),'FEFO issue skips the batch that expired yesterday and takes today''s';
 assert (select bool_and(fifo='DT-FRESH=normal/100,DT-TODAY=critical/0,DT-YESTERDAY=expired/-1') from dt),
  'the stock view counts days and states from the Kazakhstan date';
 assert (select bool_and(rate_ok) from dt),'a rate dated today is accepted';
end$$;

rollback;
