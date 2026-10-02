-- Draft, atomic posting and reversal of warehouse operation documents.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b8000000-0000-4000-8000-000000000001','inventory-doc-director@test.local','{"full_name":"Inventory Document Director"}');
insert into public.user_roles(user_id,role_id)
select 'b8000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b8100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Inventory Document Factory','FI','INV-DOC-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b8200000-0000-4000-8000-000000000001','INV-DOC-001','{"ru":"Тест складских документов"}','b8100000-0000-4000-8000-000000000001','active');

create temporary table inventory_document_context(
 source_warehouse uuid,destination_warehouse uuid,batch_id uuid,balance_id uuid,
 transfer_id uuid,write_off_id uuid,adjustment_id uuid
);
grant select,insert,update on inventory_document_context to authenticated;
insert into inventory_document_context(source_warehouse,destination_warehouse,batch_id,balance_id)
select
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 (select id from public.warehouses where status='active' and not is_virtual order by code offset 1 limit 1),
 'b8300000-0000-4000-8000-000000000001','b8400000-0000-4000-8000-000000000001';
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,created_by)
values('b8300000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000001','INV-DOC-BATCH',current_date+365,'b8000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand)
select balance_id,batch_id,source_warehouse,'piece',100 from inventory_document_context;

set role authenticated;
select set_config('request.jwt.claim.sub','b8000000-0000-4000-8000-000000000001',false);

update inventory_document_context set transfer_id=public.create_inventory_operation_document(
 'transfer',current_date,source_warehouse,destination_warehouse,'MOVE-TEST','Пополнение',null
);
select public.add_inventory_operation_line(transfer_id,balance_id,null,30,null,'Первая строка') from inventory_document_context;
do $$ declare c inventory_document_context%rowtype; begin
 select * into c from inventory_document_context;
 assert (select status='draft' from public.inventory_operation_documents where id=c.transfer_id),'new operation remains a draft';
 assert (select quantity_on_hand=100 from public.inventory_balances where id=c.balance_id),'draft does not change stock';
 perform public.post_inventory_operation_document(c.transfer_id);
 assert (select status='posted' and posted_at is not null from public.inventory_operation_documents where id=c.transfer_id),'transfer is posted';
 assert (select quantity_on_hand=70 from public.inventory_balances where id=c.balance_id),'transfer reduces source';
 assert (select quantity_on_hand=30 from public.inventory_balances where batch_id=c.batch_id and warehouse_id=c.destination_warehouse),'transfer increases destination';
 assert (select count(*)=2 from public.inventory_movements where inventory_operation_document_id=c.transfer_id and not is_reversal),'transfer ledger is linked to document';
 perform public.cancel_inventory_operation_document(c.transfer_id,'Ошибочный склад');
 assert (select status='cancelled' from public.inventory_operation_documents where id=c.transfer_id),'transfer is cancelled';
 assert (select quantity_on_hand=100 from public.inventory_balances where id=c.balance_id),'transfer reversal restores source';
 assert (select quantity_on_hand=0 from public.inventory_balances where batch_id=c.batch_id and warehouse_id=c.destination_warehouse),'transfer reversal clears destination';
 assert (select count(*)=1 from public.inventory_movements where inventory_operation_document_id=c.transfer_id and is_reversal),'reversal movement is auditable';
end $$;

update inventory_document_context set write_off_id=public.create_inventory_operation_document(
 'write_off',current_date,source_warehouse,null,'ACT-TEST','Брак',null
);
select public.add_inventory_operation_line(write_off_id,balance_id,null,10,null,null) from inventory_document_context;
select public.post_inventory_operation_document(write_off_id) from inventory_document_context;
do $$ declare c inventory_document_context%rowtype; begin
 select * into c from inventory_document_context;
 assert (select quantity_on_hand=90 from public.inventory_balances where id=c.balance_id),'write-off reduces stock';
 assert (select movement_type='write_off' from public.inventory_movements where inventory_operation_document_id=c.write_off_id and not is_reversal),'write-off movement is linked';
 perform public.cancel_inventory_operation_document(c.write_off_id,'Акт аннулирован');
 assert (select quantity_on_hand=100 from public.inventory_balances where id=c.balance_id),'write-off reversal restores stock';
end $$;

update inventory_document_context set adjustment_id=public.create_inventory_operation_document(
 'adjustment',current_date,source_warehouse,null,'COUNT-TEST','Инвентаризация',null
);
select public.add_inventory_operation_line(adjustment_id,balance_id,null,5,'increase',null) from inventory_document_context;
select public.post_inventory_operation_document(adjustment_id) from inventory_document_context;
do $$ declare c inventory_document_context%rowtype; begin
 select * into c from inventory_document_context;
 assert (select quantity_on_hand=105 from public.inventory_balances where id=c.balance_id),'positive adjustment increases stock';
 perform public.cancel_inventory_operation_document(c.adjustment_id,'Пересчёт');
 assert (select quantity_on_hand=100 from public.inventory_balances where id=c.balance_id),'adjustment reversal restores stock';
 begin
  insert into public.inventory_operation_documents(document_number,operation_type,from_warehouse_id,created_by)
  values('FORGED','write_off',c.source_warehouse,'b8000000-0000-4000-8000-000000000001');
  raise exception 'direct document insert was allowed' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when insufficient_privilege then null; end;
end $$;

reset role;
rollback;
