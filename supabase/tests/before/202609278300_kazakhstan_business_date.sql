-- Runs on the schema BEFORE 202609278300_kazakhstan_business_date.sql and proves the defect it fixes.
-- Everything is rolled back. supabase/tests/business_date.test.sql proves the business day is Kazakhstan's afterwards.
-- The functions read current_date in the session time zone, which is UTC in Supabase: between 00:00 and 05:00 in
-- Kazakhstan that is yesterday. The test cannot move the clock, so it runs the same call in two session time zones,
-- UTC−12 and UTC+14: at any moment at least one of them is on a different date than Kazakhstan, as UTC is at night.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b0d00000-0000-4000-8000-000000000001','date-before@test.local','{"full_name":"Date Before"}');
insert into public.user_roles(user_id,role_id) select 'b0d00000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b0d10000-0000-4000-8000-000000000001',array['customer'],'Date before buyer','KZ','DB-C');
create temporary table bd(zone text,sale_id uuid);
grant all on bd to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','b0d00000-0000-4000-8000-000000000001',false);
set local timezone='Etc/GMT+12';
insert into bd(zone,sale_id) select 'UTC−12',public.create_customer_order('b0d10000-0000-4000-8000-000000000001',null,
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),current_date+30,null,'UTC−12');
set local timezone='Pacific/Kiritimati';
insert into bd(zone,sale_id) select 'UTC+14',public.create_customer_order('b0d10000-0000-4000-8000-000000000001',null,
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),current_date+30,null,'UTC+14');
reset role;
set local timezone='UTC';
do $$begin
 assert exists(select 1 from bd join public.sales s on s.id=bd.sale_id where s.sale_date<>(now() at time zone 'Asia/Almaty')::date),
  'before the fix the order date follows the session time zone, not Kazakhstan';
 assert (select count(*)>=10 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and p.prosrc ~* '\mcurrent_date\M'
   and not exists(select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where lower(c)='timezone=asia/almaty')),
  'and so do the functions that read current_date';
 assert (select prosrc like '%at time zone ''UTC'')::date%' from pg_proc where oid='public.fulfill_customer_order(uuid)'::regprocedure),
  'shipping an order checks expiry against the UTC date';
 assert pg_get_viewdef('public.inventory_fifo_status'::regclass) ~* 'current_date','the stock view uses the session date';
end$$;

rollback;
