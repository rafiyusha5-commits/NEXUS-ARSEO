-- Runs on the schema BEFORE 202609277700_received_shipment_items.sql (scripts/test-db.sh executes
-- supabase/tests/before/<migration>.sql right before that migration) and proves the defect it fixes:
-- an item received with truck 1 is moved to truck 2 and received again, so the stock doubles.
-- Everything is rolled back. supabase/tests/received_shipment_items.test.sql proves it is closed afterwards.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('d7000000-0000-4000-8000-000000000001','received-before@test.local','{"full_name":"Received Before"}');
insert into public.user_roles(user_id,role_id) select 'd7000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('d7100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Received before supplier','FI','RCVB-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values('d7200000-0000-4000-8000-000000000001','RCVB-001','{"ru":"Товар до исправления"}','d7100000-0000-4000-8000-000000000001','active');
create temporary table rb(shipment_id uuid,t1 uuid,t2 uuid,item_id uuid);
grant select,insert,update on rb to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','d7000000-0000-4000-8000-000000000001',false);
insert into rb(shipment_id) select public.create_shipment_with_stages('RCVB','import','d7100000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'d7000000-0000-4000-8000-000000000001',current_date,current_date+14);
select public.add_shipment_transport(shipment_id) from rb;
select public.add_shipment_transport(shipment_id) from rb;
update rb set t1=(select id from public.shipment_transports where shipment_id=rb.shipment_id and sequence_no=1),
              t2=(select id from public.shipment_transports where shipment_id=rb.shipment_id and sequence_no=2),
              item_id=public.create_shipment_item(shipment_id,'d7200000-0000-4000-8000-000000000001','piece',10,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(item_id,t1,10) from rb;
select public.change_shipment_transport_status(t1,'arrived') from rb;
select public.receive_shipment_transport(t1,null,jsonb_build_array(jsonb_build_object('item_id',item_id,'accepted_quantity',10,
 'batch_number','RCVB-LOT','expiry_date',(current_date+300)::text)),'Receiver') from rb;
-- The defect: the received item moves to truck 2 and is received again.
select public.allocate_shipment_item(item_id,t2,10) from rb;
select public.change_shipment_transport_status(t2,'arrived') from rb;
select public.receive_shipment_transport(t2,null,jsonb_build_array(jsonb_build_object('item_id',item_id,'accepted_quantity',10,
 'batch_number','RCVB-LOT','expiry_date',(current_date+300)::text)),'Receiver') from rb;
reset role;
do $$ begin
 assert (select sum(b.quantity_on_hand) from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.batch_number='RCVB-LOT')=20,
  'before the fix one delivery of 10 is received twice: stock 20';
 assert (select count(*) from public.inventory_movements where shipment_item_id=(select item_id from rb) and movement_type='receipt')=2,
  'before the fix there are two receipts of one item';
end $$;

rollback;
