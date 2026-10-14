-- Runs on the schema BEFORE 202609278300_kazakhstan_business_date.sql and proves the defect it fixes.
-- Everything is rolled back. supabase/tests/business_date.test.sql proves the business day is Kazakhstan's afterwards.
-- 202609278100 moved sales and order shipping to the Kazakhstan date; the other functions still read current_date in
-- the session time zone, which is UTC in Supabase: between 00:00 and 05:00 in Kazakhstan that is yesterday.
-- The test cannot move the clock, so it issues stock FEFO from two session time zones, UTC−12 and UTC+14: at any
-- moment at least one of them is on a different date than Kazakhstan, as UTC is at night.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b0d00000-0000-4000-8000-000000000001','date-before@test.local','{"full_name":"Date Before"}');
insert into public.user_roles(user_id,role_id) select 'b0d00000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b0d10000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'Date before factory','FI','DB-M');
insert into public.warehouses(id,code,name,city,country) values
 ('b0d20000-0000-4000-8000-000000000001','DB-WH','{"ru":"Склад дат до исправления"}','Актобе','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,shelf_life_days) values
 ('b0d30000-0000-4000-8000-000000000001','DB-001','{"ru":"Товар с датами"}','b0d10000-0000-4000-8000-000000000002',200);
-- Expired yesterday, expires today and a fresh batch, in Kazakhstan dates; plenty of stock in each.
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by)
select b.id::uuid,'b0d30000-0000-4000-8000-000000000001',b.number,kz.today-100,kz.today+b.shift,'b0d00000-0000-4000-8000-000000000001'
from (select (now() at time zone 'Asia/Almaty')::date as today) kz
cross join (values('b0d40000-0000-4000-8000-000000000001','DB-YESTERDAY',-1),('b0d40000-0000-4000-8000-000000000002','DB-TODAY',0),
 ('b0d40000-0000-4000-8000-000000000003','DB-FRESH',100))b(id,number,shift);
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand)
select id,'b0d20000-0000-4000-8000-000000000001','piece',10 from public.inventory_batches where batch_number like 'DB-%';
create temporary table bd(zone text,issued text);
grant all on bd to authenticated;
create function pg_temp.issue_from(p_zone text) returns void language plpgsql as $$
begin
  perform set_config('timezone', p_zone, true);
  insert into bd select p_zone, string_agg(a->>'batch_number', ',')
  from jsonb_array_elements(to_jsonb(public.issue_inventory_fifo('b0d30000-0000-4000-8000-000000000001','b0d20000-0000-4000-8000-000000000001',
   'piece',1::numeric,'DB','Проверка даты'))) a;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','b0d00000-0000-4000-8000-000000000001',false);
select pg_temp.issue_from('Etc/GMT+12');
select pg_temp.issue_from('Pacific/Kiritimati');
reset role;
set local timezone='UTC';
do $$begin
 assert exists(select 1 from bd where issued<>'DB-TODAY'),
  'before the fix FEFO issue follows the session date: it issues the batch that expired yesterday or skips today''s';
 assert (select count(*)>=8 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and p.prosrc ~* '\mcurrent_date\M'
   and not exists(select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where lower(c)='timezone=asia/almaty')),
  'and so do the other functions that read current_date';
 assert pg_get_viewdef('public.inventory_fifo_status'::regclass) ~* 'current_date','the stock view uses the session date';
end$$;

rollback;
