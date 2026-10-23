-- Stock that arrives into a depleted batch is sellable again (202609277800): receiving, an inventory count
-- (adjustment) and the repair of rows stuck before; quarantined and blocked batches keep their status, also when
-- written off to zero.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('d8000000-0000-4000-8000-000000000002','restock-director@test.local','{"full_name":"Restock Director"}');
insert into public.user_roles(user_id,role_id) select 'd8000000-0000-4000-8000-000000000002',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('d8100000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'Restock supplier','FI','RST2-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('d8200000-0000-4000-8000-000000000002','RST2-001','{"ru":"Партия двумя машинами"}','d8100000-0000-4000-8000-000000000002','active'),
 ('d8200000-0000-4000-8000-000000000003','RST2-002','{"ru":"Партия на карантине"}','d8100000-0000-4000-8000-000000000002','active'),
 ('d8200000-0000-4000-8000-000000000004','RST2-003','{"ru":"Пересчёт склада"}','d8100000-0000-4000-8000-000000000002','active');
create temporary table rs(shipment_id uuid,t1 uuid,t2 uuid,t3 uuid,i1 uuid,i2 uuid,i3 uuid,i4 uuid,wh uuid,doc uuid);
grant select,insert,update on rs to authenticated;
create function pg_temp.batch(p_number text) returns uuid language sql as $$ select id from public.inventory_batches where batch_number=p_number $$;
grant execute on function pg_temp.batch(text) to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','d8000000-0000-4000-8000-000000000002',false);
insert into rs(shipment_id,wh) select public.create_shipment_with_stages('RST2','import','d8100000-0000-4000-8000-000000000002',null,
 (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'d8000000-0000-4000-8000-000000000002',current_date,current_date+14),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1);
select public.add_shipment_transport(shipment_id) from rs;
select public.add_shipment_transport(shipment_id) from rs;
update rs set t1=(select id from public.shipment_transports where shipment_id=rs.shipment_id and sequence_no=1),
              t2=(select id from public.shipment_transports where shipment_id=rs.shipment_id and sequence_no=2),
              i1=public.create_shipment_item(shipment_id,'d8200000-0000-4000-8000-000000000002','piece',10,1,(select id from public.currencies where code='EUR')),
              i3=public.create_shipment_item(shipment_id,'d8200000-0000-4000-8000-000000000003','piece',4,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(i1,t1,10) from rs;
select public.allocate_shipment_item(i3,t1,4) from rs;
select public.change_shipment_transport_status(t1,'arrived') from rs;
select public.receive_shipment_transport(t1,null,jsonb_build_array(
 jsonb_build_object('item_id',i1,'accepted_quantity',10,'batch_number','RST2-SPLIT','expiry_date',(current_date+300)::text),
 jsonb_build_object('item_id',i3,'accepted_quantity',4,'batch_number','RST2-QUAR','expiry_date',(current_date+300)::text)),'Receiver') from rs;

-- The first part is sold out; the quarantined batch is put on hold.
select public.issue_inventory_fifo('d8200000-0000-4000-8000-000000000002',wh,'piece',10::numeric,'SO','Продажа') from rs;
select public.set_inventory_batch_status(pg_temp.batch('RST2-QUAR'),'quarantine','Проверка качества');
do $$ begin assert (select status='depleted' from public.inventory_batches where id=pg_temp.batch('RST2-SPLIT')),'sold out'; end $$;

-- ---------- 1. the second truck brings more of both batches ----------
update rs set i2=public.create_shipment_item(shipment_id,'d8200000-0000-4000-8000-000000000002','piece',5,1,(select id from public.currencies where code='EUR')),
              i4=public.create_shipment_item(shipment_id,'d8200000-0000-4000-8000-000000000003','piece',3,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(i2,t2,5) from rs;
select public.allocate_shipment_item(i4,t2,3) from rs;
select public.change_shipment_transport_status(t2,'arrived') from rs;
select public.receive_shipment_transport(t2,null,jsonb_build_array(
 jsonb_build_object('item_id',i2,'accepted_quantity',5,'batch_number','RST2-SPLIT','expiry_date',(current_date+300)::text),
 jsonb_build_object('item_id',i4,'accepted_quantity',3,'batch_number','RST2-QUAR','expiry_date',(current_date+300)::text)),'Receiver') from rs;
do $$ begin
 assert (select status='available' from public.inventory_batches where id=pg_temp.batch('RST2-SPLIT')),'the sold-out batch is available again';
 assert (select status='quarantine' and status_reason='Проверка качества' from public.inventory_batches where id=pg_temp.batch('RST2-QUAR')),
  'a quarantined batch stays in quarantine';
end $$;
select public.issue_inventory_fifo('d8200000-0000-4000-8000-000000000002',wh,'piece',5::numeric,'SO','Продажа') from rs;
do $$ begin
 assert (select status='depleted' from public.inventory_batches where id=pg_temp.batch('RST2-SPLIT')),'the second part is sold too';
end $$;

-- ---------- 2. an inventory count finds more of a sold-out batch ----------
update rs set doc=public.create_inventory_operation_document('adjustment',current_date,wh,null,'Пересчёт','Найдено при пересчёте','Кладовщик');
select public.add_inventory_operation_line(doc,(select b.id from public.inventory_balances b where b.batch_id=pg_temp.batch('RST2-SPLIT') limit 1),
 null::uuid,2::numeric,'increase',null::text) from rs;
select public.post_inventory_operation_document(doc) from rs;
do $$ begin
 assert (select status='available' from public.inventory_batches where id=pg_temp.batch('RST2-SPLIT')),'found stock makes the batch available';
end $$;
select public.issue_inventory_fifo('d8200000-0000-4000-8000-000000000002',wh,'piece',2::numeric,'SO','Продажа') from rs;

-- ---------- 3. a blocked batch written off to zero stays blocked, and so does stock found later ----------
select public.set_inventory_batch_status(pg_temp.batch('RST2-QUAR'),'blocked','Отзыв производителя');
update rs set doc=public.create_inventory_operation_document('write_off',current_date,wh,null,'Отзыв','Утилизация отзыва','Кладовщик');
select public.add_inventory_operation_line(doc,(select b.id from public.inventory_balances b where b.batch_id=pg_temp.batch('RST2-QUAR') and b.quantity_on_hand>0),
 null::uuid,7::numeric,null::text,null::text) from rs;
select public.post_inventory_operation_document(doc) from rs;
do $$ begin
 assert (select status='blocked' and status_reason='Отзыв производителя' from public.inventory_batches where id=pg_temp.batch('RST2-QUAR')),
  'a blocked batch written off to zero keeps its block';
end $$;
update rs set doc=public.create_inventory_operation_document('adjustment',current_date,wh,null,'Пересчёт','Найдено при пересчёте','Кладовщик');
select public.add_inventory_operation_line(doc,(select b.id from public.inventory_balances b where b.batch_id=pg_temp.batch('RST2-QUAR') limit 1),
 null::uuid,1::numeric,'increase',null::text) from rs;
select public.post_inventory_operation_document(doc) from rs;
do $$ begin
 assert (select status='blocked' from public.inventory_batches where id=pg_temp.batch('RST2-QUAR')),'stock found in a blocked batch stays blocked';
end $$;

-- ---------- 4. rows stuck before the migration are repaired by re-applying it ----------
reset role;
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,created_by,status)
values('d8300000-0000-4000-8000-000000000001','d8200000-0000-4000-8000-000000000004','RST2-STUCK',current_date+200,'d8000000-0000-4000-8000-000000000002','depleted');
set session_replication_role=replica;
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand)
select 'd8300000-0000-4000-8000-000000000001',wh,'piece',8 from rs;
set session_replication_role=origin;
do $$ begin assert (select status='depleted' from public.inventory_batches where id='d8300000-0000-4000-8000-000000000001'),'stuck as before'; end $$;
\i :repo_root/supabase/migrations/202609277800_depleted_batch_restock.sql
do $$ begin
 assert (select status='available' from public.inventory_batches where id='d8300000-0000-4000-8000-000000000001'),'the stuck batch is repaired';
 assert (select status='blocked' from public.inventory_batches where id=pg_temp.batch('RST2-QUAR')),'the repair leaves blocked batches alone';
 assert not exists(select 1 from public.inventory_batches x where x.status='depleted'
   and exists(select 1 from public.inventory_balances b where b.batch_id=x.id and b.quantity_on_hand>0)),'no depleted batch has stock';
end $$;

rollback;
\echo 'depleted_batch_restock: all checks passed'
