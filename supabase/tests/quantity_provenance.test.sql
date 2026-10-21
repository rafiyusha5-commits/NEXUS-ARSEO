\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
create function pg_temp.check_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception '%',message; end if; end $$;
grant execute on function pg_temp.check_true(boolean,text) to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed','shipped'],
 '[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":965}]');
select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed','shipped'],
 '[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":965}]');
select pg_temp.check_true((select count(*)=2 from public.shipment_item_quantity_confirmations),'repeat confirmation duplicated history');
reset role;
-- Fixture setup only; receiving itself uses the existing business RPC.
update public.shipment_transports set status='arrived' where id='eb310000-0000-4000-8000-000000000001';
set role authenticated;
select public.receive_shipment_transport('eb310000-0000-4000-8000-000000000001',null,
 '[{"item_id":"eb400000-0000-4000-8000-000000000001","accepted_quantity":960,"damaged_quantity":0,"batch_number":"SYN-PROVENANCE","manufacture_date":"2026-01-01","expiry_date":"2030-01-01","discrepancy_reason":"Синтетическая приёмка: 5 единиц отсутствуют"}]',
 'Синтетический сотрудник',null);
create temp table result as select public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001') data;
select pg_temp.check_true((select (data#>>'{items,0,ordered}')::numeric=1000 and (data#>>'{items,0,confirmed}')::numeric=965
 and (data#>>'{items,0,shipped}')::numeric=965 and (data#>>'{items,0,received}')::numeric=960
 and (data#>>'{items,0,receipts,0,shortage}')::numeric=5 from result),'1000/965/960 or recorded shortage incorrect');
select pg_temp.check_true((select jsonb_array_length(data->'items')=3 and data#>>'{items,1,uom}'='box' from result),'split items or units lost');
select pg_temp.check_true((select data#>'{items,0,demandHistory}'='[]'::jsonb from result),'fabricated initial audit for fixture without insert trigger');
select pg_temp.check_true((select data::text !~ 'unit_price|storage_path|extracted_data|before_data' from result),'sensitive fields in projection');
select pg_temp.check_true((select data=public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001') from result),'read changed evidence');
reset role;
-- A new file version must not relabel historic evidence as current or change quantities.
update public.document_versions set is_current=false where id='eb511000-0000-4000-8000-000000000001';
update public.documents set current_version=2 where id='eb501000-0000-4000-8000-000000000001';
-- Synthetic version metadata, not a live Storage upload.
set session_replication_role=replica;
insert into public.document_versions(document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
values('eb501000-0000-4000-8000-000000000001',2,'documents/eb501000-0000-4000-8000-000000000001/00000000000000000000000000000002-synthetic.pdf','synthetic-v2.pdf','application/pdf',10,true,'eb000000-0000-4000-8000-000000000001');
set session_replication_role=origin;
set role authenticated;
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')#>>'{items,0,history,0,currentVersion}'='false','old version shown as current');
reset role;
update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001' where document_id='eb501000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')#>'{items,0,history}'='[]'::jsonb,'detached document exposed');
reset role;
update public.document_links set removed_at=null,removed_by=null where document_id='eb501000-0000-4000-8000-000000000001';
update public.documents set status='rejected' where id='eb501000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')#>'{items,0,history}'='[]'::jsonb,'rejected document exposed');
reset role;
update public.documents set status='approved',archived_at=now(),archived_by='eb000000-0000-4000-8000-000000000001',archive_reason='Synthetic archive' where id='eb501000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')#>'{items,0,history}'='[]'::jsonb,'archived document exposed');
reset role;
update public.documents set archived_at=null,archived_by=null,archive_reason=null where id='eb501000-0000-4000-8000-000000000001';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'eb000000-0000-4000-8000-000000000002',id,'deny','synthetic provenance access','eb000000-0000-4000-8000-000000000001'
from public.permissions where code in ('documents.view','inventory.view','audit.view','prices.purchase.view');
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000002',true);
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')#>'{items,0,history}'='[]'::jsonb,'personal document deny bypass');
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')::text !~ 'eb501000|DQ doc|SYN-PROVENANCE|Синтетическая приёмка','hidden source metadata leaked');
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')#>'{items,0,receipts}'='[]'::jsonb,'receipt deny bypass');
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')#>'{items,0,received}'='null'::jsonb,'received amount exposed');
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'eb000000-0000-4000-8000-000000000002',id,'deny','synthetic shipment deny','eb000000-0000-4000-8000-000000000001'
from public.permissions where code='shipments.view';
set role authenticated;
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000001')->'items'='[]'::jsonb,'shipment deny bypass');
reset role;
select pg_temp.check_true(not has_function_privilege('anon','public.shipment_quantity_provenance(uuid)','execute'),'anonymous execute');
select pg_temp.check_true(not has_function_privilege('service_role','public.shipment_quantity_provenance(uuid)','execute'),'service role broadened');
select pg_temp.check_true(not (select prosecdef from pg_proc where oid='public.shipment_quantity_provenance(uuid)'::regprocedure),'RLS bypass function');
-- Existing audit insert/update is used as evidence, with no purchase price projection.
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,unit_price)
values('eb400000-0000-4000-8000-000000000010','eb300000-0000-4000-8000-000000000002','eb200000-0000-4000-8000-000000000002','piece',1000,12345.6789);
update public.shipment_items set ordered_quantity=965 where id='eb400000-0000-4000-8000-000000000010';
set role authenticated;
select pg_temp.check_true((select x#>>'{demandHistory,0,quantity}'='1000.000' or (x#>>'{demandHistory,0,quantity}')::numeric=1000
 from jsonb_array_elements(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000002')->'items') x
 where x->>'id'='eb400000-0000-4000-8000-000000000010'),'original demand not taken from real audit');
select pg_temp.check_true(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000002')::text !~ '12345|unit_price','price in audit projection');
reset role;
-- A scalar aggregate is not subject to PostgREST's 1000-row cap. No silent partial list.
set session_replication_role=replica;
with vehicles as (
 insert into public.shipment_transports(shipment_id,sequence_no)
 select 'eb300000-0000-4000-8000-000000000002',n from generate_series(1,1001) n returning id
)
insert into public.shipment_items(shipment_id,shipment_transport_id,product_id,uom,ordered_quantity)
select 'eb300000-0000-4000-8000-000000000002',id,'eb200000-0000-4000-8000-000000000001','piece',1 from vehicles;
set session_replication_role=origin;
set role authenticated;
select pg_temp.check_true(jsonb_array_length(public.shipment_quantity_provenance('eb300000-0000-4000-8000-000000000002')->'items')=1003,'truncated projection');
reset role;
rollback;
