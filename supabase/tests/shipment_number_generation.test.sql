\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ab680000-0000-4000-8000-000000000001','shipment-number@test.local','{"full_name":"Number Director"}'),
 ('ab680000-0000-4000-8000-000000000002','shipment-number-denied@test.local','{"full_name":"Number Denied"}');
insert into public.user_roles(user_id,role_id)
select u,r.id from (values ('ab680000-0000-4000-8000-000000000001'::uuid),('ab680000-0000-4000-8000-000000000002'::uuid)) v(u)
cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ab680000-0000-4000-8000-000000000002',id,'deny','Number test','ab680000-0000-4000-8000-000000000001'
from public.permissions where code='shipments.create';
insert into public.counterparties(id,roles,legal_name,country)
values ('ab681000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Number factory','FI');
create temp table number_fixture as
select 'NAR-'||to_char(current_date,'YYYY')||'-' prefix,
 coalesce(max(substring(shipment_number from '^NAR-'||to_char(current_date,'YYYY')||'-([0-9]+)$')::numeric),0) base,
 (select id from public.routes limit 1) route_id,
 (select id from public.currencies where code='EUR') currency_id,
 (select id from public.warehouses where code='AKT') warehouse_id
from public.shipments;
grant select on number_fixture to authenticated;

-- A hole before occupied numbers must not be filled from a row count.
-- One number belongs to this year although its imported created_at is last year.
set session_replication_role=replica;
insert into public.shipments(shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by,created_at)
select f.prefix||lpad((f.base+n)::text,greatest(4,length((f.base+n)::text)),'0'),'import',
 'ab681000-0000-4000-8000-000000000001',f.route_id,(select id from public.process_templates where status='active' and is_default order by version desc limit 1),
 f.currency_id,f.warehouse_id,'ab680000-0000-4000-8000-000000000001','ab680000-0000-4000-8000-000000000001',
 case when n=3 then current_timestamp-interval '1 year' else current_timestamp end
from number_fixture f cross join (values (2),(3)) v(n);
-- Non-standard labels must not be parsed as numbers or disrupt allocation.
insert into public.shipments(shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select prefix||'not-a-number','import','ab681000-0000-4000-8000-000000000001',route_id,(select id from public.process_templates limit 1),currency_id,warehouse_id,
 'ab680000-0000-4000-8000-000000000001','ab680000-0000-4000-8000-000000000001' from number_fixture;
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','ab680000-0000-4000-8000-000000000001',true);
do $$ declare v_id uuid; f record; begin
 select * into f from number_fixture;
 v_id:=public.create_shipment_with_stages('NUMBER-GAP','import','ab681000-0000-4000-8000-000000000001',null,f.route_id,f.currency_id,f.warehouse_id,'ab680000-0000-4000-8000-000000000001');
 assert (select shipment_number=f.prefix||lpad((f.base+4)::text,greatest(4,length((f.base+4)::text)),'0') from public.shipments where id=v_id),'next number follows the largest occupied suffix, irrespective of created_at';
 assert (select created_by='ab680000-0000-4000-8000-000000000001' from public.shipments where id=v_id),'caller remains the author';
 assert (select count(*) from public.shipment_stage_runs where shipment_id=v_id)=
  (select count(*) from public.shipment_stages where process_template_id=(select process_template_id from public.shipments where id=v_id) and is_active),'all process stages are created';
end $$;
select set_config('request.jwt.claim.sub','ab680000-0000-4000-8000-000000000002',true);
do $$ declare f record; begin
 select * into f from number_fixture;
 begin
  perform public.create_shipment_with_stages('NUMBER-DENIED','import','ab681000-0000-4000-8000-000000000001',null,f.route_id,f.currency_id,f.warehouse_id,'ab680000-0000-4000-8000-000000000001');
 exception when others then
  if sqlerrm not like '%Недостаточно прав%' then raise; end if;
  return;
 end;
 raise exception 'personal deny must still prevent creation';
end $$;
reset role;
do $$ begin assert not exists(select 1 from public.shipments where project_code='NUMBER-DENIED'),'denied operation writes nothing'; end $$;

-- lpad(text,4) used to truncate 10000 to 1000; large sequences must keep every digit.
set session_replication_role=replica;
insert into public.shipments(shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select prefix||greatest(base+10,9999)::text,'import','ab681000-0000-4000-8000-000000000001',route_id,(select id from public.process_templates limit 1),currency_id,warehouse_id,
 'ab680000-0000-4000-8000-000000000001','ab680000-0000-4000-8000-000000000001' from number_fixture;
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','ab680000-0000-4000-8000-000000000001',true);
do $$ declare v_id uuid; f record; begin
 select * into f from number_fixture;
 v_id:=public.create_shipment_with_stages('NUMBER-10000','import','ab681000-0000-4000-8000-000000000001',null,f.route_id,f.currency_id,f.warehouse_id,'ab680000-0000-4000-8000-000000000001');
 assert (select shipment_number=f.prefix||(greatest(f.base+10,9999)+1)::text from public.shipments where id=v_id),'large suffix is not truncated';
end $$;
reset role;
rollback;
