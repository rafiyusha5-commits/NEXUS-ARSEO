-- Shipment transport receiving: accepted stock becomes inventory once and discrepancies stay auditable.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id,email,raw_user_meta_data) values
 ('e7000000-0000-4000-8000-000000000001','receiving-director@test.local','{"full_name":"Receiving Director"}'),
 ('e7000000-0000-4000-8000-000000000002','receiving-accountant@test.local','{"full_name":"Receiving Accountant"}');
insert into public.user_roles(user_id,role_id)
select f.user_id,r.id from (values
 ('e7000000-0000-4000-8000-000000000001'::uuid,'director'),
 ('e7000000-0000-4000-8000-000000000002'::uuid,'accountant')) f(user_id,role_code)
join public.app_roles r on r.code=f.role_code;
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('e7100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Receiving test supplier','FI','RCV-TEST-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values('e7200000-0000-4000-8000-000000000001','RCV-TEST-001','{"ru":"Тестовый товар приёмки"}',
       'e7100000-0000-4000-8000-000000000001','active');

create temporary table receiving_context(shipment_id uuid,transport_id uuid,item_id uuid,warehouse_id uuid,location_id uuid);
grant select,insert,update on receiving_context to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','e7000000-0000-4000-8000-000000000001',false);
insert into receiving_context(shipment_id,warehouse_id,location_id)
select public.create_shipment_with_stages(
 'RCV-TEST','import','e7100000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),
 (select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'e7000000-0000-4000-8000-000000000001',current_date,current_date+14),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'e7400000-0000-4000-8000-000000000001';
select public.add_shipment_transport(shipment_id) from receiving_context;
update receiving_context c set
 transport_id=(select t.id from public.shipment_transports t where t.shipment_id=c.shipment_id and t.sequence_no=1),
 item_id=public.create_shipment_item(c.shipment_id,'e7200000-0000-4000-8000-000000000001','piece',100,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(item_id,transport_id,100) from receiving_context;
select public.change_shipment_transport_status(transport_id,'arrived') from receiving_context;
reset role;
insert into public.warehouse_locations(id,warehouse_id,code,zone,status)
select location_id,warehouse_id,'RCV-STORAGE-001','storage','active' from receiving_context;

-- Invalid partitions must leave no header, item change or stock behind.
set role authenticated;
select set_config('request.jwt.claim.sub','e7000000-0000-4000-8000-000000000001',false);
do $$
declare c receiving_context%rowtype; good jsonb; bad jsonb; receipt uuid; proof jsonb;
begin
 select * into c from receiving_context;
 assert (select actual_loading_date is null and actual_arrival_date=current_date from public.shipment_transports where id=c.transport_id),'direct arrival must not invent a loading date';
 good:=jsonb_build_array(
  jsonb_build_object('item_id',c.item_id,'expected_quantity',60,'accepted_quantity',58,'damaged_quantity',0,'batch_number','MULTI-A','expiry_date',(current_date+400)::text,'discrepancy_reason','Missing 2 from A'),
  jsonb_build_object('item_id',c.item_id,'expected_quantity',40,'accepted_quantity',40,'damaged_quantity',0,'batch_number','MULTI-B','expiry_date',(current_date+350)::text));
 foreach bad in array array[
  jsonb_set(good,'{1,expected_quantity}','41'),
  ((good->0) - 'expected_quantity')||'{}'::jsonb,
  jsonb_build_array(good->0,good->0),
  jsonb_set(good,'{1,accepted_quantity}','"NaN"'),
  jsonb_set(good,'{1,accepted_quantity}','40.0001'),
  jsonb_set(good,'{1,expiry_date}','null'),
  jsonb_set(good,'{1,item_id}','"ffffffff-ffff-4fff-8fff-ffffffffffff"'),
  jsonb_set(good,'{0,discrepancy_reason}','null'),
  jsonb_set(good,'{1,manufacture_date}',to_jsonb((current_date+500)::text)),
  jsonb_build_array(good->0,(good->1)-'expected_quantity')
 ] loop
  begin
   perform public.receive_shipment_transport(c.transport_id,c.location_id,bad,'Multi Receiver',null);
   raise exception 'bad partition unexpectedly succeeded' using errcode='P0099';
  exception when sqlstate 'P0099' then raise; when others then null; end;
  assert not exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=c.transport_id),'failure creates no receipt';
  assert not exists(select 1 from public.inventory_movements where shipment_transport_id=c.transport_id),'failure creates no movement';
  assert not exists(select 1 from public.inventory_batches where source_shipment_transport_id=c.transport_id),'failure creates no batch';
  assert (select received_quantity is null from public.shipment_items where id=c.item_id),'failure leaves received quantity unchanged';
 end loop;
 -- A completely missing lot retains its evidence, but creates no stock.
 begin
  receipt:=public.receive_shipment_transport(c.transport_id,c.location_id,jsonb_set(good,'{0,accepted_quantity}','0'),'Multi Receiver','Missing lot');
  assert (select shortage_quantity=60 and inventory_batch_id is null and inventory_movement_id is null and expiry_date=current_date+400 from public.shipment_transport_receipt_items where receipt_id=receipt and batch_number='MULTI-A'),'fully missing lot remains traceable';
  assert (select count(*)=1 and sum(quantity)=40 from public.inventory_movements where shipment_transport_id=c.transport_id),'missing lot creates no movement';
  raise exception 'rollback alternative receipt' using errcode='P0098';
 exception when sqlstate 'P0098' then null; end;
 receipt:=public.receive_shipment_transport(c.transport_id,c.location_id,good,'Multi Receiver','Separate lots');
 assert (select count(*)=2 from public.shipment_transport_receipt_items where receipt_id=receipt),'two lot receipt rows';
 assert (select expected_quantity=60 and accepted_quantity=58 and shortage_quantity=2 and expiry_date=current_date+400
         from public.shipment_transport_receipt_items where receipt_id=receipt and batch_number='MULTI-A'),'shortage belongs to A';
 assert (select expected_quantity=40 and accepted_quantity=40 and shortage_quantity=0 and expiry_date=current_date+350
         from public.shipment_transport_receipt_items where receipt_id=receipt and batch_number='MULTI-B'),'B fully received with own expiry';
 assert (select received_quantity=98 and ordered_quantity=100 from public.shipment_items where id=c.item_id),'item stores sum without changing demand';
 assert (select count(*)=2 and sum(quantity)=98 from public.inventory_movements where shipment_transport_id=c.transport_id),'two exact movements';
 assert (select sum(b.quantity_on_hand)=98 from public.inventory_balances b join public.inventory_batches batch on batch.id=b.batch_id where batch.source_shipment_transport_id=c.transport_id),'stock sum';
 proof:=public.shipment_quantity_provenance(c.shipment_id);
 assert jsonb_array_length(proof->'items'->0->'receipts')=1,'one provenance event per receipt and item';
 assert (proof->'items'->0->'receipts'->0->>'expected')::numeric=100 and (proof->'items'->0->'receipts'->0->>'accepted')::numeric=98,'provenance aggregate';
 perform public.correct_shipment_dates(c.shipment_id,jsonb_build_object(
  'transports',jsonb_build_array(jsonb_build_object('id',c.transport_id,'actual_arrival_date',(current_date-2)::text)),
  'receipts',jsonb_build_array(jsonb_build_object('id',receipt,'received_on',(current_date-2)::text))), 'Date set per owner rule, declaration plus two days');
 assert (select count(*)=2 and bool_and((received_at at time zone 'Asia/Almaty')::date=current_date-2) from public.inventory_batches where source_shipment_transport_id=c.transport_id),'backdate covers both FIFO batches';
 assert exists(select 1 from public.shipment_date_corrections where shipment_id=c.shipment_id and entity_type='receipt' and reason='Date set per owner rule, declaration plus two days'),'date reason preserved';
 begin
  perform public.receive_shipment_transport(c.transport_id,c.location_id,good,'Multi Receiver',null);
  raise exception 'duplicate succeeded' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('уже принят' in sqlerrm)>0; end;
 assert (select count(*)=2 and sum(quantity)=98 from public.inventory_movements where shipment_transport_id=c.transport_id),'duplicate cannot add stock';
end $$;
reset role;
-- Personal deny still wins against the director role and hides receipt data.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'e7000000-0000-4000-8000-000000000001',id,'deny','test','e7000000-0000-4000-8000-000000000001' from public.permissions where code='shipments.view';
set role authenticated;
do $$ declare c receiving_context%rowtype; begin
 select * into c from receiving_context;
 assert not exists(select 1 from public.shipment_transport_receipt_items where shipment_item_id=c.item_id),'personal deny hides lot receipts';
 begin
  perform public.receive_shipment_transport(c.transport_id,c.location_id,'[]','Denied',null);
  raise exception 'denied user succeeded' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('Недостаточно прав' in sqlerrm)>0; end;
end $$;
reset role;
rollback;
