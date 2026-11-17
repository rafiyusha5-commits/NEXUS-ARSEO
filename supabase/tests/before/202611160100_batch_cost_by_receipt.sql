-- Runs on the schema BEFORE 202611160100_batch_cost_by_receipt.sql and proves the defect it fixes (finding Н6):
-- one shipment, two vehicles, one product, one batch. Purchase price 10 EUR in both vehicles; freight 300 EUR
-- split 100 / 200 by the invoice, so vehicle 1 costs 11.00 and vehicle 2 costs 12.00 per piece.
-- The 200 pieces of the batch must cost (100*11 + 100*12) / 200 = 11.50; before the fix they get 11.00,
-- the cost of the first vehicle only. Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('c3000000-0000-4000-8000-000000000001','batch-cost-before@example.invalid','{"full_name":"Batch cost before"}');
insert into public.user_roles(user_id,role_id)
 select 'c3000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('c3100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Before supplier','FI','C3-BEFORE');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('c3200000-0000-4000-8000-000000000001','C3-BEFORE','{"ru":"Товар до исправления"}','c3100000-0000-4000-8000-000000000001','active');
create temporary table c3_ids(k text primary key,id uuid);
grant all on c3_ids to authenticated;
select set_config('request.jwt.claim.sub','c3000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare
 eur uuid:=(select id from public.currencies where code='EUR');
 ship uuid;t1 uuid;t2 uuid;i1 uuid;i2 uuid;e uuid;calc uuid;
begin
 ship:=public.create_shipment_with_stages('C3-BEFORE','import','c3100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),eur,
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
  'c3000000-0000-4000-8000-000000000001',current_date,current_date+14);
 perform public.add_shipment_transport(ship,null,null,null,null);
 perform public.add_shipment_transport(ship,null,null,null,null);
 select id into t1 from public.shipment_transports where shipment_id=ship and sequence_no=1;
 select id into t2 from public.shipment_transports where shipment_id=ship and sequence_no=2;
 i1:=public.allocate_shipment_item(public.create_shipment_item(ship,'c3200000-0000-4000-8000-000000000001','piece',100,10,eur),t1,100);
 i2:=public.allocate_shipment_item(public.create_shipment_item(ship,'c3200000-0000-4000-8000-000000000001','piece',100,10,eur),t2,100);
 perform public.change_shipment_transport_status(t1,'arrived');
 perform public.receive_shipment_transport(t1,null,jsonb_build_array(jsonb_build_object('item_id',i1,'accepted_quantity',100,'batch_number','C3-BEFORE-LOT','expiry_date',(current_date+300)::text)),'Кладовщик',null);
 perform public.change_shipment_transport_status(t2,'arrived');
 perform public.receive_shipment_transport(t2,null,jsonb_build_array(jsonb_build_object('item_id',i2,'accepted_quantity',100,'batch_number','C3-BEFORE-LOT','expiry_date',(current_date+300)::text)),'Кладовщик',null);
 e:=public.create_expense(ship,'transport',null,300,eur,current_date,false,null,'Freight split by vehicle');
 perform public.confirm_expense(e);
 perform public.save_exact_expense_allocation(gen_random_uuid(),e,eur,null,
  public.exact_expense_allocation_context(e,eur)->>'stamp',
  jsonb_build_array(jsonb_build_object('item_id',i1::text,'amount','100.00'),jsonb_build_object('item_id',i2::text,'amount','200.00')),
  'Invoice splits freight by vehicle');
 calc:=public.calculate_shipment_cost(ship,eur);
 perform public.approve_shipment_cost(calc);
 insert into c3_ids values('calc',calc),('i1',i1),('i2',i2);
end $$;
reset role;
do $$begin
 assert (select unit_landed_cost=11 from public.cost_calculation_items where shipment_item_id=(select id from c3_ids where k='i1')),
  'BEFORE: vehicle 1 costs 11.00 per piece';
 assert (select unit_landed_cost=12 from public.cost_calculation_items where shipment_item_id=(select id from c3_ids where k='i2')),
  'BEFORE: vehicle 2 costs 12.00 per piece';
 assert (select unit_landed_cost=11 from public.inventory_batches where batch_number='C3-BEFORE-LOT'),
  'BEFORE: the whole batch of 200 pieces gets 11.00, the cost of the first vehicle, not 11.50';
end $$;
rollback;
