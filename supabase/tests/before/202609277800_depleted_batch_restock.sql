-- Runs on the schema BEFORE 202609277800_depleted_batch_restock.sql and proves the defects it fixes.
-- Everything is rolled back. supabase/tests/depleted_batch_restock.test.sql proves they are closed afterwards.
--   1. The same production batch comes with two trucks; the first part is sold out (depleted), the second is
--      received into the same batch, which stays depleted: the stock cannot be issued.
--   2. A blocked batch written off to zero becomes depleted and loses its block.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('d8000000-0000-4000-8000-000000000001','restock-before@test.local','{"full_name":"Restock Before"}');
insert into public.user_roles(user_id,role_id) select 'd8000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('d8100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Restock before supplier','FI','RSTB-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values('d8200000-0000-4000-8000-000000000001','RSTB-001','{"ru":"Товар до исправления"}','d8100000-0000-4000-8000-000000000001','active');
create temporary table rsb(shipment_id uuid,t1 uuid,t2 uuid,i1 uuid,i2 uuid,wh uuid);
grant select,insert,update on rsb to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','d8000000-0000-4000-8000-000000000001',false);
insert into rsb(shipment_id,wh) select public.create_shipment_with_stages('RSTB','import','d8100000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'d8000000-0000-4000-8000-000000000001',current_date,current_date+14),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1);
select public.add_shipment_transport(shipment_id) from rsb;
select public.add_shipment_transport(shipment_id) from rsb;
update rsb set t1=(select id from public.shipment_transports where shipment_id=rsb.shipment_id and sequence_no=1),
               t2=(select id from public.shipment_transports where shipment_id=rsb.shipment_id and sequence_no=2),
               i1=public.create_shipment_item(shipment_id,'d8200000-0000-4000-8000-000000000001','piece',10,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(i1,t1,10) from rsb;
select public.change_shipment_transport_status(t1,'arrived') from rsb;
select public.receive_shipment_transport(t1,null,jsonb_build_array(jsonb_build_object('item_id',i1,'accepted_quantity',10,
 'batch_number','RSTB-LOT','expiry_date',(current_date+300)::text)),'Receiver') from rsb;
select public.issue_inventory_fifo('d8200000-0000-4000-8000-000000000001',wh,'piece',10::numeric,'SO','Продажа') from rsb;
update rsb set i2=public.create_shipment_item(shipment_id,'d8200000-0000-4000-8000-000000000001','piece',5,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(i2,t2,5) from rsb;
select public.change_shipment_transport_status(t2,'arrived') from rsb;
select public.receive_shipment_transport(t2,null,jsonb_build_array(jsonb_build_object('item_id',i2,'accepted_quantity',5,
 'batch_number','RSTB-LOT','expiry_date',(current_date+300)::text)),'Receiver') from rsb;
reset role;
do $$ begin
 assert (select status='depleted' from public.inventory_batches where batch_number='RSTB-LOT'),'before the fix the batch stays depleted';
 assert (select sum(b.quantity_on_hand)=5 from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.batch_number='RSTB-LOT'),
  'with 5 pieces on hand';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','d8000000-0000-4000-8000-000000000001',false);
do $$ begin
 perform public.issue_inventory_fifo('d8200000-0000-4000-8000-000000000001',(select wh from rsb),'piece',1::numeric,'SO','Продажа');
 raise exception 'issued from a depleted batch' using errcode='P0099';
exception when sqlstate 'P0099' then raise; when others then
 assert position('Недостаточный доступный остаток' in sqlerrm)>0,'before the fix the received stock cannot be issued: '||sqlerrm;
end $$;

-- 2. A blocked batch written off to zero loses its block.
select public.set_inventory_batch_status((select id from public.inventory_batches where batch_number='RSTB-LOT'),'blocked','Отзыв');
select public.write_off_inventory((select b.id from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id
 where x.batch_number='RSTB-LOT' and b.quantity_on_hand>0),5,'Утилизация отзыва');
reset role;
do $$ begin
 assert (select status='depleted' from public.inventory_batches where batch_number='RSTB-LOT'),'before the fix the blocked batch becomes depleted';
end $$;

rollback;
