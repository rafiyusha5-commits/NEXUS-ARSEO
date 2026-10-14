-- Runs on the schema BEFORE 202609278200_transport_status_after_receipt.sql and proves the defects it fixes.
-- Everything is rolled back. supabase/tests/transport_status_after_receipt.test.sql proves they are closed.
-- 202609278100 already keeps a received truck from going back or being cancelled. What is left: "unloaded" can be
-- set by hand without a receipt, and then the truck cannot be received.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('c7a00000-0000-4000-8000-000000000001','transport-before@test.local','{"full_name":"Transport Before"}');
insert into public.user_roles(user_id,role_id) select 'c7a00000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('c7a10000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Transport before supplier','FI','TRB-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values
 ('c7a20000-0000-4000-8000-000000000001','TRB-001','{"ru":"Товар машины"}','c7a10000-0000-4000-8000-000000000001','active'),
 ('c7a20000-0000-4000-8000-000000000002','TRB-002','{"ru":"Товар второй машины"}','c7a10000-0000-4000-8000-000000000001','active');
create temporary table tb(shipment_id uuid,t1 uuid,t2 uuid,i1 uuid,i2 uuid);
grant select,insert,update on tb to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','c7a00000-0000-4000-8000-000000000001',false);
insert into tb(shipment_id) select public.create_shipment_with_stages('TRB','import','c7a10000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'c7a00000-0000-4000-8000-000000000001',current_date,current_date+14);
select public.add_shipment_transport(shipment_id) from tb;
select public.add_shipment_transport(shipment_id) from tb;
update tb set t1=(select id from public.shipment_transports where shipment_id=tb.shipment_id and sequence_no=1),
              t2=(select id from public.shipment_transports where shipment_id=tb.shipment_id and sequence_no=2),
              i1=public.create_shipment_item(shipment_id,'c7a20000-0000-4000-8000-000000000001','piece',10,1,(select id from public.currencies where code='EUR')),
              i2=public.create_shipment_item(shipment_id,'c7a20000-0000-4000-8000-000000000002','piece',5,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(i1,t1,10) from tb;
select public.allocate_shipment_item(i2,t2,5) from tb;
select public.change_shipment_transport_status(t1,'arrived') from tb;
select public.receive_shipment_transport(t1,null,jsonb_build_array(jsonb_build_object('item_id',i1,'accepted_quantity',10,
 'batch_number','TRB-LOT','expiry_date',(current_date+300)::text)),'Receiver') from tb;

-- "Unloaded" by hand, then receiving refuses the truck.
select public.change_shipment_transport_status(t2,'unloaded') from tb;
do $$begin
 begin
  perform public.receive_shipment_transport((select t2 from tb),null,jsonb_build_array(jsonb_build_object('item_id',(select i2 from tb),'accepted_quantity',5,
   'batch_number','TRB-LOT-2','expiry_date',(current_date+300)::text)),'Receiver');
  raise exception 'received a truck marked unloaded by hand' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then null;
 end;
end$$;
reset role;
do $$begin
 assert not exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=(select t2 from tb)),
  'before the fix a truck marked unloaded by hand has no receipt and cannot get one';
end$$;

rollback;
