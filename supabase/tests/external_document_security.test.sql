-- External document publication is administrator-only, price-safe, related and version-pinned.
\set ON_ERROR_STOP 1
begin;

create schema if not exists tests;
create or replace function tests.portal_expect_error(p_sql text,p_pattern text) returns void language plpgsql as $$begin
 execute p_sql;raise exception 'expected error but statement succeeded' using errcode='P0099';
exception when sqlstate 'P0099' then raise;when others then if sqlerrm!~*p_pattern then raise exception 'expected %, got %',p_pattern,sqlerrm using errcode='P0099';end if;end$$;
grant usage on schema tests to authenticated;
grant execute on function tests.portal_expect_error(text,text) to authenticated;

insert into auth.users(id,email,raw_user_meta_data) values
 ('fc000000-0000-4000-8000-000000000001','portal-admin@test.local','{"full_name":"Portal admin"}'),
 ('fc000000-0000-4000-8000-000000000002','portal-director@test.local','{"full_name":"Portal director"}'),
 ('fc000000-0000-4000-8000-000000000003','portal-client@test.local','{"full_name":"Portal client"}'),
 ('fc000000-0000-4000-8000-000000000004','portal-specialist@test.local','{"full_name":"Portal specialist"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('fc000000-0000-4000-8000-000000000001','administrator'),
 ('fc000000-0000-4000-8000-000000000002','director'),
 ('fc000000-0000-4000-8000-000000000004','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('fc100000-0000-4000-8000-000000000001',array['customer'],'Secure portal customer','KZ','SECURE-A'),
 ('fc100000-0000-4000-8000-000000000002',array['customer'],'Other portal customer','KZ','SECURE-B');

set role authenticated;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',false);
select public.configure_external_client('fc000000-0000-4000-8000-000000000003','fc100000-0000-4000-8000-000000000001','Portal client',null,'ru',true,true,true);

-- A client upload is visible only through the reduced portal RPC, never through base tables.
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000003',false);
insert into storage.objects(bucket_id,name,owner_id,metadata) values(
 'nexus-documents','documents/fc200000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-client.pdf',
 'fc000000-0000-4000-8000-000000000003','{"size":100,"mimetype":"application/pdf"}');
select public.register_external_document(
 'fc200000-0000-4000-8000-000000000001',(select id from public.document_types where code='cmr'),'Client file',
 'documents/fc200000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-client.pdf','client.pdf');
do $$begin
 assert (select count(*) from public.documents)=0,'external user cannot query document metadata directly';
 assert (select count(*) from public.document_versions)=0,'external user cannot query version history directly';
 assert (select count(*) from public.my_external_documents())=1,'client sees its published upload through the safe RPC';
 assert (select version_number=1 from public.my_external_document('fc200000-0000-4000-8000-000000000001')),'only the pinned version is returned';
 perform set_config('tests.portal_old_version',(select version_id::text from public.my_external_document('fc200000-0000-4000-8000-000000000001')),false);
end$$;

-- External uploads cannot be placed in an existing document folder.
select tests.portal_expect_error($q$
 insert into storage.objects(bucket_id,name,owner_id,metadata) values(
  'nexus-documents','documents/fc200000-0000-4000-8000-000000000001/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-foreign.pdf',
  'fc000000-0000-4000-8000-000000000003','{"size":100,"mimetype":"application/pdf"}')
$q$,'row-level security|policy');

-- A later employee version revokes publication until an administrator reviews it.
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',false);
insert into storage.objects(bucket_id,name,owner_id,metadata) values(
 'nexus-documents','documents/fc200000-0000-4000-8000-000000000001/cccccccccccccccccccccccccccccccc-v2.pdf',
 'fc000000-0000-4000-8000-000000000001','{"size":110,"mimetype":"application/pdf"}');
insert into public.document_versions(document_id,storage_path,original_filename) values(
 'fc200000-0000-4000-8000-000000000001','documents/fc200000-0000-4000-8000-000000000001/cccccccccccccccccccccccccccccccc-v2.pdf','v2.pdf');
do $$begin assert (select visibility='internal' and external_shared_version_id is null from public.documents where id='fc200000-0000-4000-8000-000000000001'),'new version revokes old publication';end$$;

-- A director cannot publish, and an administrator cannot select an unrelated customer.
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000002',false);
select tests.portal_expect_error($q$select public.set_document_external_access('fc200000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000001',true)$q$,'Только администратор');
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',false);
select tests.portal_expect_error($q$select public.set_document_external_access('fc200000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000002',true)$q$,'не связан');
select public.set_document_external_access('fc200000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000001',true);

select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000003',false);
do $$declare v2 uuid;begin
 select version_id into v2 from public.my_external_document('fc200000-0000-4000-8000-000000000001');
 assert (select version_number=2 from public.my_external_document('fc200000-0000-4000-8000-000000000001')),'administrator publishes only reviewed v2';
 assert (select count(*) from public.my_external_document_file('fc200000-0000-4000-8000-000000000001',
  current_setting('tests.portal_old_version')::uuid))=0,'superseded v1 is unavailable';
 assert (select count(*) from public.my_external_document_file('fc200000-0000-4000-8000-000000000001',v2))=1,'pinned version is downloadable';
end$$;

-- Internal employee uploads, including invoices, cannot be published at all.
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',false);
insert into storage.objects(bucket_id,name,owner_id,metadata) values(
 'nexus-documents','documents/fc200000-0000-4000-8000-000000000002/dddddddddddddddddddddddddddddddd-invoice.pdf',
 'fc000000-0000-4000-8000-000000000001','{"size":120,"mimetype":"application/pdf"}');
select public.register_document(
 'fc200000-0000-4000-8000-000000000002',(select id from public.document_types where code='invoice'),'Internal invoice',
 'documents/fc200000-0000-4000-8000-000000000002/dddddddddddddddddddddddddddddddd-invoice.pdf','invoice.pdf',
 p_links=>'[{"entity_type":"customer","entity_id":"fc100000-0000-4000-8000-000000000001","link_role":"primary"}]');
select tests.portal_expect_error($q$select public.set_document_external_access('fc200000-0000-4000-8000-000000000002','fc100000-0000-4000-8000-000000000001',true)$q$,'Внутренний или ценовой');

-- An internal employee with documents.view can read the uploaded invoice file even
-- without templates.generate_prices or prices.purchase.view.
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000004',false);
do $$begin
 assert (select count(*) from public.documents where id='fc200000-0000-4000-8000-000000000002')=1,'employee sees the internal invoice';
 assert (select count(*) from public.document_versions where document_id='fc200000-0000-4000-8000-000000000002')=1,'employee sees the invoice file version';
 assert (select count(*) from storage.objects where name like 'documents/fc200000-0000-4000-8000-000000000002/%')=1,'employee can read the registered invoice file';
end$$;

-- Generated shipment documents: fixtures as the table owner, triggers off.
reset role;
insert into auth.users(id,email,raw_user_meta_data) values
 ('fc000000-0000-4000-8000-000000000005','portal-admin-denied@test.local','{"full_name":"Denied admin"}');
insert into public.user_roles(user_id,role_id) select 'fc000000-0000-4000-8000-000000000005',id from public.app_roles where code='administrator';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'fc000000-0000-4000-8000-000000000005',id,'deny','portal test','fc000000-0000-4000-8000-000000000001' from public.permissions where code='documents.view';
set session_replication_role=replica;
insert into public.shipments(id,shipment_number,type,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'fc300000-0000-4000-8000-000000000001','PORTAL-EXP-1','export','fc100000-0000-4000-8000-000000000001',
 (select id from public.routes limit 1),(select id from public.process_templates limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where code='AKT'),'fc000000-0000-4000-8000-000000000001','fc000000-0000-4000-8000-000000000001';
insert into public.document_templates(id,document_type_id,name,language,status,approved_by,approved_at,flow_direction,current_version,created_by)
values('fc400000-0000-4000-8000-000000000001',(select id from public.document_types where code='cmr'),'Portal template','ru','approved',
 'fc000000-0000-4000-8000-000000000001',now(),'output',1,'fc000000-0000-4000-8000-000000000001');
insert into public.document_template_versions(id,template_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,uploaded_by)
values('fc410000-0000-4000-8000-000000000001','fc400000-0000-4000-8000-000000000001',1,
 'templates/fc400000-0000-4000-8000-000000000001/00000000000000000000000000000001-t.docx','t.docx',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,'fc000000-0000-4000-8000-000000000001');
create temp table portal_fx(id uuid,type_code text,source text,generated boolean,prices boolean,versions int);
insert into portal_fx values
 ('fc500000-0000-4000-8000-000000000001','cmr','manual_upload',true,false,2),
 ('fc500000-0000-4000-8000-000000000002','packing_list','manual_upload',true,true,1),
 ('fc500000-0000-4000-8000-000000000003','cmr','manual_upload',false,false,1),
 ('fc500000-0000-4000-8000-000000000004','cmr','google_drive_import',false,false,1);
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select f.id,t.id,'Generated '||f.type_code,'approved',f.source,'fc000000-0000-4000-8000-000000000001',f.versions
from portal_fx f join public.document_types t on t.code=f.type_code;
insert into public.document_versions(document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select f.id,v,'documents/'||f.id||'/'||lpad(v::text,32,'0')||'-v'||v||'.pdf','v'||v||'.pdf','application/pdf',10,v=f.versions,'fc000000-0000-4000-8000-000000000001'
from portal_fx f cross join generate_series(1,2) v where v<=f.versions;
insert into storage.objects(bucket_id,name,owner_id,metadata)
select 'nexus-documents',storage_path,'fc000000-0000-4000-8000-000000000001','{"size":10,"mimetype":"application/pdf"}'
from public.document_versions where document_id in (select id from portal_fx);
insert into public.document_links(document_id,entity_type,entity_id,created_by)
select id,'shipment','fc300000-0000-4000-8000-000000000001','fc000000-0000-4000-8000-000000000001' from portal_fx;
insert into public.document_generations(template_id,template_version_id,shipment_id,document_id,output_format,contains_prices,fields_snapshot,generated_by)
select 'fc400000-0000-4000-8000-000000000001','fc410000-0000-4000-8000-000000000001','fc300000-0000-4000-8000-000000000001',id,'pdf',prices,'{}',
 'fc000000-0000-4000-8000-000000000001' from portal_fx where generated;
set session_replication_role=origin;
do $$begin
 assert (select array_agg(r.code) from public.role_permissions rp join public.app_roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
   where p.code='documents.share_external' and rp.granted)=array['administrator'],'only the administrator role may publish';
end$$;

set role authenticated;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',false);
select tests.portal_expect_error($q$select public.set_document_external_access('fc500000-0000-4000-8000-000000000002','fc100000-0000-4000-8000-000000000001',true)$q$,'Внутренний или ценовой');
select tests.portal_expect_error($q$select public.set_document_external_access('fc500000-0000-4000-8000-000000000003','fc100000-0000-4000-8000-000000000001',true)$q$,'Внутренний или ценовой');
select tests.portal_expect_error($q$select public.set_document_external_access('fc500000-0000-4000-8000-000000000004','fc100000-0000-4000-8000-000000000001',true)$q$,'Внутренний или ценовой');
select tests.portal_expect_error($q$select public.set_document_external_access('fc500000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000002',true)$q$,'не связан');
select public.set_document_external_access('fc500000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000005',false);
select tests.portal_expect_error($q$select public.set_document_external_access('fc500000-0000-4000-8000-000000000001',null,false)$q$,'Только администратор');

select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000003',false);
do $$begin
 assert (select count(*) from public.document_links)=0,'external user cannot query document links directly';
 assert exists(select 1 from public.my_external_documents() where id='fc500000-0000-4000-8000-000000000001'),'price-free generated CMR is published to the linked client';
 assert (select count(*) from storage.objects where name like 'documents/fc500000-0000-4000-8000-000000000001/%-v1.pdf')=0,'superseded generated version is unavailable in Storage';
 assert (select count(*) from storage.objects where name like 'documents/fc500000-0000-4000-8000-000000000001/%-v2.pdf')=1,'pinned generated version is readable in Storage';
end$$;

-- Generated documents with prices stay hidden from employees without templates.generate_prices.
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000004',false);
do $$begin
 assert (select count(*) from public.documents where id='fc500000-0000-4000-8000-000000000002')=0,'price document row hidden';
 assert (select count(*) from public.document_versions where document_id='fc500000-0000-4000-8000-000000000002')=0,'price document versions hidden';
 assert (select count(*) from public.document_links where document_id='fc500000-0000-4000-8000-000000000002')=0,'price document links hidden';
 assert (select count(*) from storage.objects where name like 'documents/fc500000-0000-4000-8000-000000000002/%')=0,'price document file hidden';
 assert (select count(*) from public.documents where id='fc500000-0000-4000-8000-000000000001')=1,'price-free generated document stays visible';
end$$;

reset role;
rollback;
select 'external_document_security: passed' as result;
