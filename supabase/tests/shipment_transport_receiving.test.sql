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
insert into receiving_context(shipment_id,item_id,warehouse_id,location_id)
select public.create_shipment_with_stages(
 'RCV-TEST','import','e7100000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),
 (select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'e7000000-0000-4000-8000-000000000001',current_date,current_date+14),
 'e7300000-0000-4000-8000-000000000001',
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'e7400000-0000-4000-8000-000000000001';
select public.add_shipment_transport(shipment_id) from receiving_context;
update receiving_context c set transport_id=(select t.id from public.shipment_transports t where t.shipment_id=c.shipment_id and t.sequence_no=1);
insert into public.shipment_items(id,shipment_id,product_id,ordered_quantity,uom,unit_price,currency_id)
select item_id,shipment_id,'e7200000-0000-4000-8000-000000000001',100,'piece',1,(select id from public.currencies where code='EUR')
from receiving_context;
select public.allocate_shipment_item(item_id,transport_id,100) from receiving_context;
select public.change_shipment_transport_status(transport_id,'arrived') from receiving_context;
reset role;
insert into public.warehouse_locations(id,warehouse_id,code,zone,status)
select location_id,warehouse_id,'RCV-STORAGE-001','storage','active' from receiving_context;

set role authenticated;
select set_config('request.jwt.claim.sub','e7000000-0000-4000-8000-000000000001',false);
do $$
declare c receiving_context%rowtype; receipt uuid; qty numeric; n bigint;
begin
 select * into c from receiving_context;
 select public.receive_shipment_transport(c.transport_id,c.location_id,jsonb_build_array(jsonb_build_object(
  'item_id',c.item_id,'accepted_quantity',92,'damaged_quantity',3,'batch_number','RCV-BATCH-001',
  'manufacture_date',(current_date-30)::text,'expiry_date',(current_date+335)::text,
  'discrepancy_reason','5 units missing and 3 units damaged')),'Warehouse Receiver','Integration test') into receipt;
 assert receipt is not null,'receiving RPC returns a receipt id';
 assert (select count(*) from public.shipment_transport_receipts where id=receipt and shipment_transport_id=c.transport_id)=1,'receipt header is created';
 assert (select accepted_quantity=92 and damaged_quantity=3 and shortage_quantity=5 and overage_quantity=0
         from public.shipment_transport_receipt_items where receipt_id=receipt and shipment_item_id=c.item_id),
        'receipt item records accepted, damaged and shortage quantities';
 select b.quantity_on_hand into qty from public.inventory_balances b join public.inventory_batches batch on batch.id=b.batch_id
 where batch.source_shipment_item_id=c.item_id and batch.source_shipment_transport_id=c.transport_id and b.warehouse_location_id=c.location_id;
 assert qty=92,'accepted quantity is posted to inventory';
 select quantity into qty from public.inventory_movements where shipment_transport_id=c.transport_id and shipment_item_id=c.item_id and movement_type='receipt';
 assert qty=92,'inventory movement is linked to the vehicle';
 select received_quantity into qty from public.shipment_items where id=c.item_id;
 assert qty=95,'received quantity includes accepted and damaged units';
 assert (select status='unloaded' from public.shipment_transports where id=c.transport_id),'transport is marked unloaded';
 select count(*) into n from public.shipment_stage_runs run join public.shipment_stages stage on stage.id=run.stage_id
 where run.shipment_transport_id=c.transport_id and stage.code in ('warehouse_receiving','quantity_check','batch_registration','putaway') and run.status='completed';
 assert n=4,'receiving stages are completed, including putaway';
 assert (select count(*) from public.shipment_stage_history h join public.shipment_stage_runs run on run.id=h.stage_run_id
         join public.shipment_stages stage on stage.id=run.stage_id where run.shipment_transport_id=c.transport_id
         and stage.code in ('warehouse_receiving','quantity_check','batch_registration','putaway') and h.to_status='completed')=4,
        'automatic stage transitions are recorded';
end $$;

-- A duplicate call must fail without changing stock.
do $$
declare c receiving_context%rowtype; receipts bigint; movements bigint; balance numeric;
begin
 select * into c from receiving_context;
 select count(*) into receipts from public.shipment_transport_receipts where shipment_transport_id=c.transport_id;
 select count(*) into movements from public.inventory_movements where shipment_transport_id=c.transport_id;
 select coalesce(sum(b.quantity_on_hand),0) into balance from public.inventory_balances b join public.inventory_batches batch on batch.id=b.batch_id
 where batch.source_shipment_transport_id=c.transport_id;
 begin
  perform public.receive_shipment_transport(c.transport_id,c.location_id,jsonb_build_array(jsonb_build_object(
   'item_id',c.item_id,'accepted_quantity',100,'damaged_quantity',0,'batch_number','RCV-BATCH-DUPLICATE','expiry_date',(current_date+335)::text)),
   'Warehouse Receiver',null);
  raise exception 'duplicate receiving unexpectedly succeeded' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('уже принят' in sqlerrm)>0,'duplicate call fails for expected reason'; end;
 assert (select count(*) from public.shipment_transport_receipts where shipment_transport_id=c.transport_id)=receipts,'duplicate adds no receipt';
 assert (select count(*) from public.inventory_movements where shipment_transport_id=c.transport_id)=movements,'duplicate adds no movement';
 assert (select coalesce(sum(b.quantity_on_hand),0) from public.inventory_balances b join public.inventory_batches batch on batch.id=b.batch_id
         where batch.source_shipment_transport_id=c.transport_id)=balance,'duplicate does not change stock';
end $$;

-- Permission is checked before payload and vehicle state.
select set_config('request.jwt.claim.sub','e7000000-0000-4000-8000-000000000002',false);
do $$
declare c receiving_context%rowtype;
begin
 select * into c from receiving_context;
 begin
  perform public.receive_shipment_transport(c.transport_id,c.location_id,'[]'::jsonb,'Accountant',null);
  raise exception 'accountant unexpectedly received stock' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('Недостаточно прав' in sqlerrm)>0,'permission denial is returned'; end;
end $$;
reset role;
rollback;
