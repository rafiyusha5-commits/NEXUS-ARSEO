-- Committed fixtures in the disposable test database only.
\set ON_ERROR_STOP 1
insert into auth.users(id,email,raw_user_meta_data)
values ('ab689000-0000-4000-8000-000000000001','shipment-number-parallel@test.local','{"full_name":"Parallel Director"}');
insert into public.user_roles(user_id,role_id)
select 'ab689000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country)
values ('ab689100-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Parallel factory','FI');
create table tests.shipment_number_inputs as
select (select id from public.routes limit 1) route_id,
 (select id from public.currencies where code='EUR') currency_id,
 (select id from public.warehouses where code='AKT') warehouse_id,
 'NAR-'||to_char(current_date,'YYYY')||'-' prefix,
 greatest(coalesce(max(substring(shipment_number from '^NAR-'||to_char(current_date,'YYYY')||'-([0-9]+)$')::numeric),0)+100,9999) base
from public.shipments;
grant usage on schema tests to authenticated;
grant select on tests.shipment_number_inputs to authenticated;
set session_replication_role=replica;
insert into public.shipments(shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by,created_at)
select prefix||base::text,'import','ab689100-0000-4000-8000-000000000001',route_id,(select id from public.process_templates limit 1),currency_id,warehouse_id,
 'ab689000-0000-4000-8000-000000000001','ab689000-0000-4000-8000-000000000001',current_timestamp-interval '1 year'
from tests.shipment_number_inputs;
set session_replication_role=origin;
