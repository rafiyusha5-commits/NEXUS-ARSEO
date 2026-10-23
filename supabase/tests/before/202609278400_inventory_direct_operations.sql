-- Runs on the schema BEFORE 202609278400_inventory_direct_operations.sql and proves the defects it fixes.
-- Everything is rolled back. supabase/tests/inventory_direct_operations.test.sql proves they are closed afterwards.
--   1. An employee writes off and transfers stock through the API directly: the stock changes, no warehouse
--      document exists for it.
--   2. A write-off document refuses a batch in quarantine, so recalled goods could leave only by the direct call.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('d9000000-0000-4000-8000-000000000002','direct-ops-before@test.local','{"full_name":"Direct Operations Before"}');
insert into public.user_roles(user_id,role_id) select 'd9000000-0000-4000-8000-000000000002',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('d9100000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'Direct operations before','FI','DOPB-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values('d9200000-0000-4000-8000-000000000002','DOPB-001','{"ru":"Товар до исправления"}','d9100000-0000-4000-8000-000000000002','active');
create temporary table dopb(wh uuid,wh2 uuid,doc uuid);
grant select,insert,update on dopb to authenticated;
insert into dopb(wh,wh2) select
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 (select id from public.warehouses where status='active' and not is_virtual order by code offset 1 limit 1);
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,created_by,status,status_reason) values
 ('d9300000-0000-4000-8000-000000000011','d9200000-0000-4000-8000-000000000002','DOPB-AVAIL',current_date+300,'d9000000-0000-4000-8000-000000000002','available',null),
 ('d9300000-0000-4000-8000-000000000012','d9200000-0000-4000-8000-000000000002','DOPB-QUAR',current_date+300,'d9000000-0000-4000-8000-000000000002','quarantine','Отзыв');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) select v.id,v.batch,dopb.wh,'piece',10 from dopb,(values
 ('d9400000-0000-4000-8000-000000000011'::uuid,'d9300000-0000-4000-8000-000000000011'::uuid),
 ('d9400000-0000-4000-8000-000000000012'::uuid,'d9300000-0000-4000-8000-000000000012'::uuid)) v(id,batch);

set role authenticated;
select set_config('request.jwt.claim.sub','d9000000-0000-4000-8000-000000000002',false);
-- 1. the direct calls change stock without a document
select public.write_off_inventory('d9400000-0000-4000-8000-000000000011',3,'Без документа');
select public.transfer_inventory_batch('d9400000-0000-4000-8000-000000000011',wh2,null,2) from dopb;
-- 2. the write-off document refuses the quarantined batch
update dopb set doc=public.create_inventory_operation_document('write_off',current_date,wh,null,'Акт','Утилизация отзыва',null);
do $$ begin
 perform public.add_inventory_operation_line((select doc from dopb),'d9400000-0000-4000-8000-000000000012',null,10,null,null);
 raise exception 'BEFORE: the quarantined batch was accepted by the write-off document';
exception when others then
 if sqlerrm !~ 'Партия недоступна для операции' then raise; end if;
end $$;
reset role;

do $$ begin
 assert (select quantity_on_hand=5 from public.inventory_balances where id='d9400000-0000-4000-8000-000000000011'),
  'BEFORE: the direct calls took 5 pieces off the source';
 assert (select count(*)=3 from public.inventory_movements where batch_id='d9300000-0000-4000-8000-000000000011'
   and inventory_operation_document_id is null),
  'BEFORE: three movements exist without a warehouse document';
end $$;

rollback;
