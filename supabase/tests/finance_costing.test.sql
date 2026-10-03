-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('c7000000-0000-4000-8000-000000000001','finance-director@test.local','{"full_name":"Finance Director"}'),
 ('c7000000-0000-4000-8000-000000000002','finance-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('c7000000-0000-4000-8000-000000000003','finance-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('c7000000-0000-4000-8000-000000000001','director'),('c7000000-0000-4000-8000-000000000002','accountant'),('c7000000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('c7100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','FIN-SUP'),
 ('c7100000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','FIN-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('c7200000-0000-4000-8000-000000000001','FIN-001','{"ru":"Финансовый тестовый товар"}','c7100000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','c7000000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'c7300000-0000-4000-8000-000000000001','FIN-SHIP-001','import','c7100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'c7000000-0000-4000-8000-000000000003','c7000000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('c7400000-0000-4000-8000-000000000001','c7300000-0000-4000-8000-000000000001','c7200000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('c7500000-0000-4000-8000-000000000001','c7200000-0000-4000-8000-000000000001','c7400000-0000-4000-8000-000000000001','FIN-BATCH','2027-12-31','c7000000-0000-4000-8000-000000000001');

set role authenticated;
select set_config('request.jwt.claim.sub','c7000000-0000-4000-8000-000000000001',false);
select public.add_exchange_rate((select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),500,'official','Тест',current_date);

select set_config('request.jwt.claim.sub','c7000000-0000-4000-8000-000000000003',false);
select public.create_expense('c7300000-0000-4000-8000-000000000001','transport','c7100000-0000-4000-8000-000000000002',100,(select id from public.currencies where code='EUR'),current_date,false,null,'Доставка');
do $$begin
 begin perform public.confirm_expense((select id from public.expenses where shipment_id='c7300000-0000-4000-8000-000000000001'));raise exception 'logistic confirmed expense' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert position('Нет права' in sqlerrm)>0,'logistic cannot confirm';end;
end$$;

select set_config('request.jwt.claim.sub','c7000000-0000-4000-8000-000000000002',false);
select public.confirm_expense((select id from public.expenses where shipment_id='c7300000-0000-4000-8000-000000000001'));
select public.allocate_expense((select id from public.expenses where shipment_id='c7300000-0000-4000-8000-000000000001'),'by_quantity',(select id from public.currencies where code='KZT'));
do $$begin
 assert (select allocated_amount=50000 from public.expense_allocations where shipment_item_id='c7400000-0000-4000-8000-000000000001'),'100 EUR converted to 50,000 KZT';
 assert (select status='allocated' from public.expenses where shipment_id='c7300000-0000-4000-8000-000000000001'),'expense allocated';
end$$;
select public.calculate_shipment_cost('c7300000-0000-4000-8000-000000000001',(select id from public.currencies where code='KZT'));
do $$begin
 assert (select goods_total=10000 and expenses_total=50000 and landed_total=60000 from public.cost_calculations where shipment_id='c7300000-0000-4000-8000-000000000001'),'landed total calculated';
 assert (select unit_landed_cost=6000 from public.cost_calculation_items where shipment_item_id='c7400000-0000-4000-8000-000000000001'),'unit landed cost calculated';
end$$;

select set_config('request.jwt.claim.sub','c7000000-0000-4000-8000-000000000001',false);
select public.approve_shipment_cost((select id from public.cost_calculations where shipment_id='c7300000-0000-4000-8000-000000000001'));
do $$begin
 assert (select status='approved' from public.cost_calculations where shipment_id='c7300000-0000-4000-8000-000000000001'),'cost approved';
 assert (select unit_landed_cost=6000 and cost_currency_id=(select id from public.currencies where code='KZT')
         from public.my_inventory_batch_costs('c7200000-0000-4000-8000-000000000001') where batch_id='c7500000-0000-4000-8000-000000000001'),
        'approved cost flows to batch through the protected cost reader';
end$$;

reset role;
rollback;
