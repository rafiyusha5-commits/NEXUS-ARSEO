-- Synthetic namespace dedicated to the assistant draft tests and their concurrency runner.
create schema if not exists tests;
create table tests.assistant_draft_context(payload jsonb not null,review jsonb,result jsonb);
grant usage on schema tests to authenticated;
grant all on tests.assistant_draft_context to authenticated;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ad000000-8a22-4000-8000-000000000001','assistant-draft@example.invalid','{"full_name":"Synthetic Draft Operator"}'),
 ('ad000000-8a22-4000-8000-000000000002','assistant-draft-other@example.invalid','{"full_name":"Synthetic Other Operator"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from auth.users u cross join public.app_roles r
 where u.id in ('ad000000-8a22-4000-8000-000000000001','ad000000-8a22-4000-8000-000000000002') and r.code='director';
insert into public.counterparties(id,roles,legal_name,country,min_remaining_shelf_life_pct,notes) values
 ('ad000000-8a22-4000-8000-000000000011',array['customer'],'Synthetic draft buyer','KZ',70,'PRIVATE-SYNTHETIC-NOTE'),
 ('ad000000-8a22-4000-8000-000000000012',array['manufacturer'],'Synthetic draft factory','KZ',null,null);
insert into public.warehouses(id,code,name,city,country) values
 ('ad000000-8a22-4000-8000-000000000031','SYNTH-AI-DRAFT','{"ru":"Синтетический склад заказа"}','Synthetic','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id) values
 ('ad000000-8a22-4000-8000-000000000021','SYNTH-AI-DRAFT-1','{"ru":"Синтетическое печенье"}','ad000000-8a22-4000-8000-000000000012'),
 ('ad000000-8a22-4000-8000-000000000022','SYNTH-AI-DRAFT-2','{"ru":"Синтетический сок"}','ad000000-8a22-4000-8000-000000000012');
update public.products set status='active',brand='Synth Draft' where id in ('ad000000-8a22-4000-8000-000000000021','ad000000-8a22-4000-8000-000000000022');
-- Prices come only from the price list (202611170200): a box of 2 at 50 per piece, juice at 0.33 per piece.
insert into public.product_packaging(product_id,uom,units_per_parent) values ('ad000000-8a22-4000-8000-000000000021','box',2);
insert into public.brands(name,brand_key,created_by) values ('Synth Draft',private.brand_key('Synth Draft'),'ad000000-8a22-4000-8000-000000000001');
insert into public.price_list_entries(price_type_id,product_id,price,valid_from,origin,reason,created_by)
 select t.id,v.product,v.price,'2020-01-01','manual','Синтетическая цена','ad000000-8a22-4000-8000-000000000001'
 from public.price_types t cross join (values ('ad000000-8a22-4000-8000-000000000021'::uuid,50::numeric),('ad000000-8a22-4000-8000-000000000022'::uuid,0.33::numeric)) v(product,price)
 where t.code='kz_prepayment';
insert into public.customer_price_terms(customer_id,price_type_id,contract_currency_id,valid_from,reason,created_by)
 select 'ad000000-8a22-4000-8000-000000000011',(select id from public.price_types where code='kz_prepayment'),id,'2020-01-01','Синтетический договор','ad000000-8a22-4000-8000-000000000001'
 from public.currencies where code='KZT';
insert into public.contracts(id,counterparty_id,number,type,currency_id,status,valid_from,valid_to) values
 ('ad000000-8a22-4000-8000-000000000041','ad000000-8a22-4000-8000-000000000011','SYNTH-DRAFT-CONTRACT','sale',(select id from public.currencies where code='KZT'),'active','2020-01-01','2099-12-31');
insert into tests.assistant_draft_context(payload) select jsonb_build_object(
 'customer_id','ad000000-8a22-4000-8000-000000000011','contract_id','ad000000-8a22-4000-8000-000000000041',
 'warehouse_id','ad000000-8a22-4000-8000-000000000031','currency_id',id,'planned_shipment_date','2099-01-20',
 'items',jsonb_build_array(
  jsonb_build_object('product_id','ad000000-8a22-4000-8000-000000000021','quantity','2','uom','box'),
  jsonb_build_object('product_id','ad000000-8a22-4000-8000-000000000022','quantity','3','uom','piece')))
 from public.currencies where code='KZT';
select set_config('request.jwt.claim.sub','ad000000-8a22-4000-8000-000000000001',false);
