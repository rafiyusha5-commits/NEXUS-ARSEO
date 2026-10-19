\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
create function pg_temp.refuses(sql text) returns void language plpgsql as $$
begin
 begin execute sql; exception when others then return; end;
 raise exception 'Expected refusal: %',sql;
end $$;
grant execute on function pg_temp.refuses(text) to authenticated;
insert into private.drive_gateway_config(id,secret_sha256) values(true,encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'))
on conflict(id) do update set secret_sha256=excluded.secret_sha256;
set session_replication_role=replica;
update public.shipments set status='closed',is_locked=true,closed_at=now(),closed_by='eb000000-0000-4000-8000-000000000001' where id='eb300000-0000-4000-8000-000000000002';
set session_replication_role=origin;
create temp table original_sources as select * from public.shipment_source_extractions;
create temp table original_items as select * from public.shipment_items;
create temp table original_stock as select * from public.inventory_movements;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select set_config('request.headers','{}',true);
select pg_temp.refuses($q$select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Folder_123456789','Shipment')$q$);
select set_config('request.headers',jsonb_build_object('x-nexus-drive-gateway',repeat('a',64))::text,true);
select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000002','Closed_folder_123','Closed shipment');
select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Folder_123456789','Shipment');
select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Folder_123456789','Shipment');
select pg_temp.refuses($q$select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Folder_other_123','Other')$q$);
select public.scan_shipment_drive_folder(shipment_id,generation,
 '[{"file_id":"File_123456789","name":"invoice.pdf","path":"import/invoice.pdf","mime_type":"application/pdf","revision":"10","size":100},
 {"file_id":"Copy_123456789","name":"copy.pdf","path":"copy.pdf","mime_type":"application/pdf","revision":"20","size":100}]')
 from public.shipment_drive_folders where shipment_id='eb300000-0000-4000-8000-000000000001';
select pg_temp.refuses($q$select public.scan_shipment_drive_folder('eb300000-0000-4000-8000-000000000001',gen_random_uuid(),'[]')$q$);
insert into storage.objects(bucket_id,name,owner_id,metadata) values
 ('nexus-documents','documents/fd000000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-invoice.pdf',
 'eb000000-0000-4000-8000-000000000001','{"size":100,"mimetype":"application/pdf"}');
select public.import_shipment_drive_file('eb300000-0000-4000-8000-000000000001','File_123456789','10',repeat('1',64),
 'fd000000-0000-4000-8000-000000000001',(select id from public.document_types where code='invoice'),
 'documents/fd000000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-invoice.pdf');
-- A retry and a renamed/copied Drive file reuse the same document. No second upload required.
do $$declare d uuid;begin
 d:=public.import_shipment_drive_file('eb300000-0000-4000-8000-000000000001','File_123456789','10',repeat('1',64),gen_random_uuid(),
 (select id from public.document_types where code='invoice'),'unused');
 assert d='fd000000-0000-4000-8000-000000000001';
 d:=public.import_shipment_drive_file('eb300000-0000-4000-8000-000000000001','Copy_123456789','20',repeat('1',64),gen_random_uuid(),
 (select id from public.document_types where code='invoice'),'unused');
 assert d='fd000000-0000-4000-8000-000000000001';
 assert (select count(*) from public.document_versions where checksum_sha256=repeat('1',64))=1;
 assert (select count(*) from public.document_links where document_id=d and removed_at is null)=1;
end $$;
-- Changing the Drive version cannot replace an imported document or its confirmations.
select public.scan_shipment_drive_folder(shipment_id,generation,
 '[{"file_id":"File_123456789","name":"renamed.pdf","path":"renamed.pdf","mime_type":"application/pdf","revision":"11","size":200}]')
 from public.shipment_drive_folders where shipment_id='eb300000-0000-4000-8000-000000000001';
select pg_temp.refuses($q$select public.import_shipment_drive_file('eb300000-0000-4000-8000-000000000001','File_123456789','11',repeat('2',64),gen_random_uuid(),(select id from public.document_types where code='invoice'),'unused')$q$);
select pg_temp.refuses($q$select public.import_shipment_drive_file('eb300000-0000-4000-8000-000000000001','File_123456789','10',repeat('1',64),gen_random_uuid(),(select id from public.document_types where code='invoice'),'unused')$q$);
do $$begin
 assert (select imported_revision='10' and revision='11' from public.shipment_drive_files where file_id='File_123456789');
 assert (select not present and imported_document_id is not null from public.shipment_drive_files where file_id='Copy_123456789');
end $$;
-- Every relevant personal deny closes both cached metadata and RPC paths, even with gateway.
reset role;
do $$declare denied_code text;begin
 foreach denied_code in array array['shipments.view','shipments.update','documents.view','documents.drive.view','prices.purchase.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'eb000000-0000-4000-8000-000000000001',id,'deny','drive test','eb000000-0000-4000-8000-000000000001' from public.permissions p where p.code=denied_code;
  set local role authenticated;
  assert (select count(*) from public.shipment_drive_folders)=0;
  assert (select count(*) from public.shipment_drive_files)=0;
  perform pg_temp.refuses($q$select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Folder_123456789','Shipment')$q$);
  reset role;
  delete from public.user_permission_overrides o using public.permissions p where o.permission_id=p.id and p.code=denied_code and o.user_id='eb000000-0000-4000-8000-000000000001';
 end loop;
end $$;
do $$begin
 assert not exists((select * from public.shipment_source_extractions except select * from original_sources) union all (select * from original_sources except select * from public.shipment_source_extractions)), 'manual confirmations untouched';
 assert not exists((select * from public.shipment_items except select * from original_items) union all (select * from original_items except select * from public.shipment_items)), 'shipment quantities untouched';
 assert not exists((select * from public.inventory_movements except select * from original_stock) union all (select * from original_stock except select * from public.inventory_movements)), 'stock untouched';
 assert not has_table_privilege('service_role','public.shipment_drive_files','select');
 assert not has_function_privilege('anon','public.import_shipment_drive_file(uuid,text,text,text,uuid,uuid,text,text)','execute');
end $$;
rollback;
