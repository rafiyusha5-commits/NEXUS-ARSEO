-- Write-off and transfer only through a warehouse document (202609278400): the direct RPCs are closed to the API,
-- a write-off document takes a batch in quarantine or blocked and keeps its status, a transfer takes only an
-- available batch, also when the batch is put on hold between the draft and the posting.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('d9000000-0000-4000-8000-000000000001','direct-ops-director@test.local','{"full_name":"Direct Operations Director"}');
insert into public.user_roles(user_id,role_id) select 'd9000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('d9100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Direct operations supplier','FI','DOP-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('d9200000-0000-4000-8000-000000000001','DOP-001','{"ru":"Прямые операции"}','d9100000-0000-4000-8000-000000000001','active');

create temporary table dop(wh uuid,wh2 uuid,doc uuid,doc2 uuid);
grant select,insert,update on dop to authenticated;
insert into dop(wh,wh2) select
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 (select id from public.warehouses where status='active' and not is_virtual order by code offset 1 limit 1);
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,created_by,status,status_reason) values
 ('d9300000-0000-4000-8000-000000000001','d9200000-0000-4000-8000-000000000001','DOP-AVAIL',current_date+300,'d9000000-0000-4000-8000-000000000001','available',null),
 ('d9300000-0000-4000-8000-000000000002','d9200000-0000-4000-8000-000000000001','DOP-QUAR',current_date+300,'d9000000-0000-4000-8000-000000000001','quarantine','Проверка качества'),
 ('d9300000-0000-4000-8000-000000000003','d9200000-0000-4000-8000-000000000001','DOP-BLOCK',current_date+300,'d9000000-0000-4000-8000-000000000001','blocked','Отзыв производителя'),
 ('d9300000-0000-4000-8000-000000000004','d9200000-0000-4000-8000-000000000001','DOP-GONE',current_date+300,'d9000000-0000-4000-8000-000000000001','depleted',null);
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) select v.id,v.batch,dop.wh,'piece',v.qty from dop,(values
 ('d9400000-0000-4000-8000-000000000001'::uuid,'d9300000-0000-4000-8000-000000000001'::uuid,20::numeric),
 ('d9400000-0000-4000-8000-000000000002'::uuid,'d9300000-0000-4000-8000-000000000002'::uuid,6::numeric),
 ('d9400000-0000-4000-8000-000000000003'::uuid,'d9300000-0000-4000-8000-000000000003'::uuid,4::numeric),
 ('d9400000-0000-4000-8000-000000000004'::uuid,'d9300000-0000-4000-8000-000000000004'::uuid,0::numeric)) v(id,batch,qty);
do $$ begin
 assert (select status='depleted' from public.inventory_batches where id='d9300000-0000-4000-8000-000000000004'),'setup: the batch is depleted';
end $$;

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;

-- ---------- 1. the direct RPCs are closed, even for a director with every warehouse permission ----------
set role authenticated;
select set_config('request.jwt.claim.sub','d9000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$select public.write_off_inventory('d9400000-0000-4000-8000-000000000001',5,'Брак')$$,'permission denied');
select pg_temp.fails($$select public.transfer_inventory_batch('d9400000-0000-4000-8000-000000000001',(select wh2 from dop),null,5)$$,'permission denied');
reset role;
do $$ begin
 assert (select quantity_on_hand=20 from public.inventory_balances where id='d9400000-0000-4000-8000-000000000001'),'stock unchanged';
 assert not exists(select 1 from public.inventory_movements where batch_id='d9300000-0000-4000-8000-000000000001'),'no movement without a document';
 assert not has_function_privilege('authenticated','public.write_off_inventory(uuid,numeric,text,text,text)','execute'),'write-off closed';
 assert not has_function_privilege('authenticated','public.transfer_inventory_batch(uuid,uuid,uuid,numeric,text,text,text)','execute'),'transfer closed';
 assert not has_function_privilege('service_role','public.write_off_inventory(uuid,numeric,text,text,text)','execute'),'closed to the server key too';
 assert not has_function_privilege('anon','public.transfer_inventory_batch(uuid,uuid,uuid,numeric,text,text,text)','execute'),'closed to anon';
end $$;

-- ---------- 2. a write-off document takes batches in quarantine and blocked and keeps their status ----------
set role authenticated;
select set_config('request.jwt.claim.sub','d9000000-0000-4000-8000-000000000001',false);
update dop set doc=public.create_inventory_operation_document('write_off',current_date,wh,null,'Акт','Утилизация',null);
select public.add_inventory_loss_line(doc,'d9400000-0000-4000-8000-000000000002',6,null,'damaged',null) from dop;
select public.add_inventory_loss_line(doc,'d9400000-0000-4000-8000-000000000003',1,null,'damaged',null) from dop;
select public.add_inventory_loss_line(doc,'d9400000-0000-4000-8000-000000000001',2,null,'damaged',null) from dop;
select pg_temp.fails($$select public.add_inventory_operation_line((select doc from dop),'d9400000-0000-4000-8000-000000000004',null,1,null,null)$$,
 'Партия недоступна для операции');
select public.post_inventory_operation_document(doc) from dop;
reset role;
do $$ declare c dop%rowtype; begin
 select * into c from dop;
 assert (select quantity_on_hand=0 from public.inventory_balances where id='d9400000-0000-4000-8000-000000000002'),'quarantine written off';
 assert (select quantity_on_hand=3 from public.inventory_balances where id='d9400000-0000-4000-8000-000000000003'),'blocked written off in part';
 assert (select quantity_on_hand=18 from public.inventory_balances where id='d9400000-0000-4000-8000-000000000001'),'available written off';
 assert (select status='quarantine' and status_reason='Проверка качества' from public.inventory_batches where id='d9300000-0000-4000-8000-000000000002'),
  'a quarantined batch written off to zero keeps its status and reason';
 assert (select status='blocked' and status_reason='Отзыв производителя' from public.inventory_batches where id='d9300000-0000-4000-8000-000000000003'),
  'a blocked batch keeps its block';
 assert (select count(*)=3 from public.inventory_movements where inventory_operation_document_id=c.doc and movement_type='write_off' and not is_reversal),
  'every write-off is linked to the document';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','d9000000-0000-4000-8000-000000000001',false);
select public.cancel_inventory_operation_document(doc,'Акт аннулирован') from dop;
reset role;
do $$ begin
 assert (select quantity_on_hand=6 from public.inventory_balances where id='d9400000-0000-4000-8000-000000000002'),'reversal restores the quarantined stock';
 assert (select status='quarantine' from public.inventory_batches where id='d9300000-0000-4000-8000-000000000002'),'and the batch stays in quarantine';
 assert (select quantity_on_hand=4 from public.inventory_balances where id='d9400000-0000-4000-8000-000000000003'),'reversal restores the blocked stock';
 assert (select status='blocked' from public.inventory_batches where id='d9300000-0000-4000-8000-000000000003'),'and the batch stays blocked';
end $$;

-- ---------- 3. a transfer takes only an available batch, also at the posting ----------
set role authenticated;
select set_config('request.jwt.claim.sub','d9000000-0000-4000-8000-000000000001',false);
update dop set doc2=public.create_inventory_operation_document('transfer',current_date,wh,wh2,'Перемещение','Пополнение',null);
select pg_temp.fails($$select public.add_inventory_operation_line((select doc2 from dop),'d9400000-0000-4000-8000-000000000002',null,1,null,null)$$,
 'Партия недоступна для операции');
select pg_temp.fails($$select public.add_inventory_operation_line((select doc2 from dop),'d9400000-0000-4000-8000-000000000003',null,1,null,null)$$,
 'Партия недоступна для операции');
select public.add_inventory_operation_line(doc2,'d9400000-0000-4000-8000-000000000001',null,5,null,null) from dop;
select public.set_inventory_batch_status('d9300000-0000-4000-8000-000000000001','quarantine','Жалоба покупателя');
select pg_temp.fails($$select public.post_inventory_operation_document((select doc2 from dop))$$,'Партия недоступна для перемещения');
select public.set_inventory_batch_status('d9300000-0000-4000-8000-000000000001','available',null);
select public.post_inventory_operation_document(doc2) from dop;
reset role;
do $$ declare c dop%rowtype; begin
 select * into c from dop;
 assert (select quantity_on_hand=15 from public.inventory_balances where id='d9400000-0000-4000-8000-000000000001'),'the transfer left the source (the write-off was reversed)';
 assert (select quantity_on_hand=5 from public.inventory_balances where batch_id='d9300000-0000-4000-8000-000000000001' and warehouse_id=c.wh2),
  'and reached the destination';
 assert (select count(*)=2 from public.inventory_movements where inventory_operation_document_id=c.doc2 and movement_type='transfer'),
  'the transfer is linked to the document';
end $$;

rollback;
\echo 'inventory_direct_operations: all checks passed'
