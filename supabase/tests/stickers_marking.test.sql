-- Sticker layout approval, 3%/100 print calculation, application and marking order.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('c6000000-0000-4000-8000-000000000001','sticker-director@test.local','{"full_name":"Sticker Director"}'),
 ('c6000000-0000-4000-8000-000000000002','sticker-marketer@test.local','{"full_name":"Sticker Marketer"}'),
 ('c6000000-0000-4000-8000-000000000003','sticker-logistic@test.local','{"full_name":"Sticker Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('c6000000-0000-4000-8000-000000000001','director'),('c6000000-0000-4000-8000-000000000002','marketer'),('c6000000-0000-4000-8000-000000000003','logistics_specialist')) u(id,role_code)
join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('c6100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Sticker Supplier','FI','ST-SUP'),
 ('c6100000-0000-4000-8000-000000000002',array['customer'],'Sticker Customer','KZ','ST-CUS'),
 ('c6100000-0000-4000-8000-000000000003',array['printing_house'],'Sticker Print','KZ','ST-PRINT');
insert into public.products(id,internal_sku,name,manufacturer_id,status,requires_sticker,requires_marking) values
 ('c6200000-0000-4000-8000-000000000001','STICK-001','{"ru":"Ирис тестовый 120 г"}','c6100000-0000-4000-8000-000000000001','active',true,true);
select set_config('request.jwt.claim.sub','c6000000-0000-4000-8000-000000000001',false);
insert into public.documents(id,document_type_id,title,status,current_version,uploaded_by)
select 'c6300000-0000-4000-8000-000000000001',id,'Макет стикера STICK-001','approved',1,'c6000000-0000-4000-8000-000000000001'
from public.document_types where code='sticker_layout';
insert into public.shipments(id,shipment_number,type,supplier_id,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'c6400000-0000-4000-8000-000000000001','STICK-SHIP-001','import','c6100000-0000-4000-8000-000000000001','c6100000-0000-4000-8000-000000000002',
 (select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual limit 1),'c6000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,ordered_quantity,confirmed_quantity,uom) values
 ('c6500000-0000-4000-8000-000000000001','c6400000-0000-4000-8000-000000000001','c6200000-0000-4000-8000-000000000001',480,480,'piece');
do $$ begin assert exists(select 1 from public.tasks where shipment_id='c6400000-0000-4000-8000-000000000001' and entity_type='sticker_layout' and status='open'),'missing layout creates marketer task';end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','c6000000-0000-4000-8000-000000000002',false);
select public.create_sticker_template('STICK-001 KZ','c6200000-0000-4000-8000-000000000001','c6100000-0000-4000-8000-000000000002','unit',array['ru','kk'],'{"name":"{{product.name_ru}}"}','c6300000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub','c6000000-0000-4000-8000-000000000001',false);
do $$ begin
 begin perform public.create_sticker_order('c6400000-0000-4000-8000-000000000001','c6100000-0000-4000-8000-000000000003',3,100);raise exception 'draft layout accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise;when others then assert position('нет утверждённого макета' in sqlerrm)>0,'draft version cannot be printed';end;
end $$;

select set_config('request.jwt.claim.sub','c6000000-0000-4000-8000-000000000002',false);
select public.submit_sticker_template_version((select id from public.sticker_template_versions where sticker_template_id=(select id from public.sticker_templates where name='STICK-001 KZ')));
select set_config('request.jwt.claim.sub','c6000000-0000-4000-8000-000000000001',false);
select public.decide_sticker_template_version((select id from public.sticker_template_versions where sticker_template_id=(select id from public.sticker_templates where name='STICK-001 KZ')),true,'Согласовано');
do $$ begin assert exists(select 1 from public.tasks where shipment_id='c6400000-0000-4000-8000-000000000001' and entity_type='sticker_layout' and status='done'),'approved layout closes marketer task';end $$;
select public.create_sticker_order('c6400000-0000-4000-8000-000000000001','c6100000-0000-4000-8000-000000000003',3,100);
do $$ begin
 assert (select calculated_quantity=495 and ordered_quantity=500 from public.sticker_order_items where product_id='c6200000-0000-4000-8000-000000000001'),'480 + 3% = 495, print run = 500';
 assert (select render_data_snapshot->>'sku'='STICK-001' from public.sticker_order_items where product_id='c6200000-0000-4000-8000-000000000001'),'print data snapshot saved';
end $$;
select public.change_sticker_order_status((select id from public.sticker_orders where shipment_id='c6400000-0000-4000-8000-000000000001'),'ordered');
select public.change_sticker_order_status((select id from public.sticker_orders where shipment_id='c6400000-0000-4000-8000-000000000001'),'received');
select set_config('request.jwt.claim.sub','c6000000-0000-4000-8000-000000000003',false);
select public.record_sticker_application((select id from public.sticker_order_items where product_id='c6200000-0000-4000-8000-000000000001'),480,7,'Работник склада');
do $$ begin assert (select status='applied' from public.sticker_orders where shipment_id='c6400000-0000-4000-8000-000000000001'),'all required units complete stickering';end $$;

select set_config('request.jwt.claim.sub','c6000000-0000-4000-8000-000000000001',false);
select public.create_marking_code_order('c6100000-0000-4000-8000-000000000002','c6400000-0000-4000-8000-000000000001','c6200000-0000-4000-8000-000000000001',480,'unit');
select public.update_marking_code_order((select id from public.marking_code_orders where product_id='c6200000-0000-4000-8000-000000000001'),'partially_applied',480,470,null);
do $$ begin assert (select quantity_received=480 and quantity_applied=470 from public.marking_code_orders where product_id='c6200000-0000-4000-8000-000000000001'),'marking totals saved';end $$;

reset role;
rollback;
