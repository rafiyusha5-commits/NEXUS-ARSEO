-- Runs on the schema BEFORE 202609278700_purchase_rate_date.sql and proves the defect it fixes: goods received twenty
-- days ago are converted at the rate of the day of the calculation, so a new rate changes their cost.
-- Everything is rolled back. supabase/tests/purchase_rate_date.test.sql proves the rate of the receipt day afterwards.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('db000000-0000-4000-8000-000000000011','rate-before-director@test.local','{"full_name":"Rate Before Director"}'),
 ('db000000-0000-4000-8000-000000000012','rate-before-accountant@test.local','{"full_name":"Rate Before Accountant"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('db000000-0000-4000-8000-000000000011'::uuid,'director'),('db000000-0000-4000-8000-000000000012'::uuid,'accountant')) u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('db100000-0000-4000-8000-000000000011',array['manufacturer','supplier'],'Rate before supplier','FI','RDB-SUP');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('db200000-0000-4000-8000-000000000011','RDB-1','{"ru":"Принятый товар"}','db100000-0000-4000-8000-000000000011','active');
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000011',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'db300000-0000-4000-8000-000000000011','RDB-1','import','db100000-0000-4000-8000-000000000011',(select id from public.routes limit 1),
 (select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'db000000-0000-4000-8000-000000000011','db000000-0000-4000-8000-000000000011';
insert into public.shipment_transports(id,shipment_id,sequence_no,status) values
 ('db400000-0000-4000-8000-000000000011','db300000-0000-4000-8000-000000000011',1,'unloaded');
insert into public.shipment_transport_receipts(shipment_id,shipment_transport_id,warehouse_id,performed_by_name,received_by,received_at)
select 'db300000-0000-4000-8000-000000000011','db400000-0000-4000-8000-000000000011',
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'Кладовщик','db000000-0000-4000-8000-000000000011',now()-interval '20 days';
insert into public.shipment_items(id,shipment_id,shipment_transport_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id)
values('db600000-0000-4000-8000-000000000011','db300000-0000-4000-8000-000000000011','db400000-0000-4000-8000-000000000011',
 'db200000-0000-4000-8000-000000000011','piece',10,10,2.0,(select id from public.currencies where code='EUR'));
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),r.rate,'official',current_date-r.ago,
 'db000000-0000-4000-8000-000000000011'
from (values(40,500),(0,550)) r(ago,rate);

set role authenticated;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000012',false);
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000011',(select id from public.currencies where code='KZT'));
reset role;
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),600,'bank',current_date,
 'db000000-0000-4000-8000-000000000011';
set role authenticated;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000012',false);
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000011',(select id from public.currencies where code='KZT'));
reset role;

do $$ begin
 assert (select goods_total=11000 from public.cost_calculations where shipment_id='db300000-0000-4000-8000-000000000011' and version_number=1),
  'BEFORE: goods received twenty days ago are converted at the rate of today (10 x 2 x 550), not of their receipt day (500)';
 assert (select goods_total=12000 from public.cost_calculations where shipment_id='db300000-0000-4000-8000-000000000011' and version_number=2),
  'BEFORE: the same received goods cost more after a new rate of today (10 x 2 x 600)';
end $$;

rollback;
