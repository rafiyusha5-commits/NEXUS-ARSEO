-- Synthetic focused regression, not the complete shipment lifecycle. Rollback only.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
create temp table transfer_context as select
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1) src,
 (select id from public.warehouses where status='active' and not is_virtual order by code offset 1 limit 1) dst,
 null::uuid doc;
grant select,update on transfer_context to authenticated;
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by)
values
 ('ea100000-0000-4000-8000-000000000001','eb200000-0000-4000-8000-000000000001','eb400000-0000-4000-8000-000000000001','SYNTH-ORIGIN-A','2099-12-31','eb000000-0000-4000-8000-000000000001'),
 ('ea100000-0000-4000-8000-000000000002','eb200000-0000-4000-8000-000000000001','eb400000-0000-4000-8000-000000000009','SYNTH-ORIGIN-B','2099-12-31','eb000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand)
select 'ea200000-0000-4000-8000-000000000001'::uuid,'ea100000-0000-4000-8000-000000000001'::uuid,src,'piece',20 from transfer_context
union all
select 'ea200000-0000-4000-8000-000000000002'::uuid,'ea100000-0000-4000-8000-000000000002'::uuid,src,'piece',30 from transfer_context;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
set role authenticated;
update transfer_context set doc=public.create_inventory_operation_document('transfer','2099-01-10',src,dst,'SYNTH-MOVE','Synthetic provenance check',null);
select public.add_inventory_operation_line(doc,'ea200000-0000-4000-8000-000000000002',null,5,null,null) from transfer_context;
select public.post_inventory_operation_document(doc) from transfer_context;
reset role;
do $$begin
 assert (select quantity_on_hand=20 from public.inventory_balances where id='ea200000-0000-4000-8000-000000000001'),'other receipt untouched';
 assert (select quantity_on_hand=25 from public.inventory_balances where id='ea200000-0000-4000-8000-000000000002'),'selected warehouse balance reduced';
 assert (select quantity_on_hand=5 from public.inventory_balances where batch_id='ea100000-0000-4000-8000-000000000002' and warehouse_id=(select dst from transfer_context)),'destination retains original batch';
 assert (select source_shipment_item_id='eb400000-0000-4000-8000-000000000009' from public.inventory_batches where id='ea100000-0000-4000-8000-000000000002'),'source receipt preserved';
 assert not exists(select 1 from public.inventory_movements where inventory_operation_document_id=(select doc from transfer_context)
  and (batch_id<>'ea100000-0000-4000-8000-000000000002' or shipment_id='eb300000-0000-4000-8000-000000000001')),'foreign receipt attributed to audited shipment';
 assert (select count(*)=2 from public.inventory_movements where inventory_operation_document_id=(select doc from transfer_context)),'exact transfer ledger';
end $$;
-- Reposting may be rejected or a no-op, but must never make another transfer.
set role authenticated;
do $$begin
 begin perform public.post_inventory_operation_document((select doc from transfer_context));
 exception when others then
  if sqlerrm not ilike '%черновик%' and sqlerrm not ilike '%провед%' then raise; end if;
 end;
end $$;
reset role;
do $$begin
 assert (select quantity_on_hand=25 from public.inventory_balances where id='ea200000-0000-4000-8000-000000000002'),'replay changed stock';
 assert (select count(*)=2 from public.inventory_movements where inventory_operation_document_id=(select doc from transfer_context)),'replay duplicated movements';
end $$;
rollback;
