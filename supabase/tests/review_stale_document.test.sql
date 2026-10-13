-- Confirmed and shipped quantities from source documents (202609277200): permissions, document state and kind,
-- vehicle scope, validation, history of every change, no history for unchanged values, closed shipments.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('eb000000-0000-4000-8000-000000000001','dq-director@test.local','{"full_name":"DQ Director"}'),
 ('eb000000-0000-4000-8000-000000000002','dq-noreview@test.local','{"full_name":"DQ No review"}'),
 ('eb000000-0000-4000-8000-000000000003','dq-noupdate@test.local','{"full_name":"DQ No update"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('eb000000-0000-4000-8000-000000000001'),('eb000000-0000-4000-8000-000000000002'),('eb000000-0000-4000-8000-000000000003')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select x.u::uuid,p.id,'deny','document quantities test','eb000000-0000-4000-8000-000000000001' from (values
 ('eb000000-0000-4000-8000-000000000002','source_documents.review'),
 ('eb000000-0000-4000-8000-000000000003','shipments.update')) x(u,code) join public.permissions p on p.code=x.code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('eb100000-0000-4000-8000-000000000001',array['customer'],'DQ customer','KZ','DQ-A'),
 ('eb100000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'DQ supplier','FI','DQ-B');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('eb200000-0000-4000-8000-000000000001','DQ-001','{"ru":"Товар DQ 1"}','eb100000-0000-4000-8000-000000000002','active'),
 ('eb200000-0000-4000-8000-000000000002','DQ-002','{"ru":"Товар DQ 2"}','eb100000-0000-4000-8000-000000000002','active');

set session_replication_role=replica;
insert into public.shipments(id,shipment_number,type,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select s.id::uuid,s.num,'export','eb100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates limit 1),
 (select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),'eb000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000001'
from (values ('eb300000-0000-4000-8000-000000000001','DQ-1'),('eb300000-0000-4000-8000-000000000002','DQ-OTHER')) s(id,num);
insert into public.shipment_transports(id,shipment_id,sequence_no) values
 ('eb310000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001',1),
 ('eb310000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000001',2);
insert into public.shipment_items(id,shipment_id,shipment_transport_id,product_id,uom,ordered_quantity) values
 ('eb400000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000001','eb200000-0000-4000-8000-000000000001','piece',1000),
 ('eb400000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000002','eb200000-0000-4000-8000-000000000002','box',50),
 ('eb400000-0000-4000-8000-000000000003','eb300000-0000-4000-8000-000000000001',null,'eb200000-0000-4000-8000-000000000002','box',20),
 ('eb400000-0000-4000-8000-000000000009','eb300000-0000-4000-8000-000000000002',null,'eb200000-0000-4000-8000-000000000001','piece',5);
-- Documents: 1 invoice (whole shipment), 2 packing list of vehicle 1, 3 unconfirmed invoice, 4 driver document.
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select ('eb50'||n||'000-0000-4000-8000-000000000001')::uuid,(select id from public.document_types where code='driver_document'),'DQ doc '||n,'approved','manual_upload','eb000000-0000-4000-8000-000000000001',1
from generate_series(1,4) n;
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select ('eb51'||n||'000-0000-4000-8000-000000000001')::uuid,('eb50'||n||'000-0000-4000-8000-000000000001')::uuid,1,
 'documents/eb50'||n||'000-0000-4000-8000-000000000001/00000000000000000000000000000001-d.pdf','d.pdf','application/pdf',10,true,'eb000000-0000-4000-8000-000000000001'
from generate_series(1,4) n;
insert into public.shipment_source_extractions(id,shipment_id,document_id,document_version_id,shipment_transport_id,source_kind,status,extractor_version,requested_by,reviewed_by,reviewed_at)
select ('eb60'||n||'000-0000-4000-8000-000000000001')::uuid,'eb300000-0000-4000-8000-000000000001',('eb50'||n||'000-0000-4000-8000-000000000001')::uuid,('eb51'||n||'000-0000-4000-8000-000000000001')::uuid,
 case n when 2 then 'eb310000-0000-4000-8000-000000000001'::uuid end,
 case n when 1 then 'invoice' when 2 then 'specification' when 3 then 'invoice' else 'driver_document' end,
 case n when 3 then 'extracted' else 'confirmed' end,'rules-test','eb000000-0000-4000-8000-000000000001',
 case n when 3 then null else 'eb000000-0000-4000-8000-000000000001'::uuid end,case n when 3 then null else now() end
from generate_series(1,4) n;
insert into public.document_links(document_id,entity_type,entity_id,created_by)
select id,'shipment','eb300000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000001'
from public.documents where id::text like 'eb50%';
set session_replication_role=origin;

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;


select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
set session_replication_role=replica;
update public.document_versions set is_current=false where id='eb511000-0000-4000-8000-000000000001';
insert into public.document_versions(document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
values('eb501000-0000-4000-8000-000000000001',2,'documents/eb501000-0000-4000-8000-000000000001/00000000000000000000000000000002-new.pdf','new.pdf','application/pdf',10,true,'eb000000-0000-4000-8000-000000000001');
update public.documents set current_version=2 where id='eb501000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($q$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$q$,'заменён');
select confirmed_quantity from public.shipment_items where id='eb400000-0000-4000-8000-000000000001';


do $$ begin
 assert (select confirmed_quantity is null from public.shipment_items where id='eb400000-0000-4000-8000-000000000001'), 'Stale source did not alter quantity';
 assert not exists(select 1 from public.shipment_item_quantity_confirmations), 'Stale source did not create history';
end $$;
-- Even a confirmed extraction of the current version is unusable after unlinking or rejecting the document.
reset role;
set session_replication_role=replica;
update public.shipment_source_extractions set document_version_id=(select id from public.document_versions
 where document_id='eb501000-0000-4000-8000-000000000001' and is_current)
 where id='eb601000-0000-4000-8000-000000000001';
update public.document_links set removed_at=now(), removed_by='eb000000-0000-4000-8000-000000000001' where document_id='eb501000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
select pg_temp.fails($q$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$q$,'отвязан');
reset role;
set session_replication_role=replica;
update public.document_links set removed_at=null, removed_by=null where document_id='eb501000-0000-4000-8000-000000000001';
update public.documents set status='rejected' where id='eb501000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
select pg_temp.fails($q$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$q$,'отклонён');
do $$ begin
 assert not exists(select 1 from public.shipment_item_quantity_confirmations), 'Inactive evidence did not create history';
end $$;
rollback;
