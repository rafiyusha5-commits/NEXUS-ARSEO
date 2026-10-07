-- CMR, ТТН and packing list are issued as XLSX sheets of the filled export workbook (202609274700).
-- The package RPC registers four XLSX files atomically and rejects the former PDF forms.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('fd000000-0000-4000-8000-000000000001','xlsx-director@test.local','{"full_name":"XLSX Director"}');
insert into public.user_roles(user_id,role_id) select 'fd000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('fd100000-0000-4000-8000-000000000001',array['customer'],'XLSX package customer','KZ','XLSX-A');

set session_replication_role=replica;
insert into public.shipments(id,shipment_number,type,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'fd300000-0000-4000-8000-000000000001','XLSX-EXP-1','export','fd100000-0000-4000-8000-000000000001',
 (select id from public.routes limit 1),(select id from public.process_templates limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where code='AKT'),'fd000000-0000-4000-8000-000000000001','fd000000-0000-4000-8000-000000000001';
insert into public.document_templates(id,document_type_id,name,language,status,approved_by,approved_at,flow_direction,current_version,created_by)
values('fd400000-0000-4000-8000-000000000001',(select id from public.document_types where code='shipment_workbook'),'XLSX package template','ru','approved',
 'fd000000-0000-4000-8000-000000000001',now(),'output',1,'fd000000-0000-4000-8000-000000000001');
insert into public.document_template_versions(id,template_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,uploaded_by)
values('fd410000-0000-4000-8000-000000000001','fd400000-0000-4000-8000-000000000001',1,
 'templates/fd400000-0000-4000-8000-000000000001/00000000000000000000000000000001-t.xlsx','t.xlsx',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',10,'fd000000-0000-4000-8000-000000000001');
insert into storage.objects(bucket_id,name,owner_id,metadata)
select 'nexus-documents','documents/'||id||'/00000000000000000000000000000001-'||code||'.xlsx','fd000000-0000-4000-8000-000000000001','{"size":10,"mimetype":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}'
from (values ('fd500000-0000-4000-8000-000000000001'::uuid,'workbook'),('fd500000-0000-4000-8000-000000000002','cmr'),('fd500000-0000-4000-8000-000000000003','ttn'),('fd500000-0000-4000-8000-000000000004','packing')) f(id,code);
set session_replication_role=origin;

create temp table xlsx_files as
select * from (values
 (1,'fd500000-0000-4000-8000-000000000001','shipment_workbook','workbook','Рабочая книга отгрузки'),
 (2,'fd500000-0000-4000-8000-000000000002','cmr','cmr','CMR'),
 (3,'fd500000-0000-4000-8000-000000000003','ttn','ttn','ТТН'),
 (4,'fd500000-0000-4000-8000-000000000004','packing_list','packing','Упаковочный лист')) v(n,document_id,type_code,file_code,label);
grant select on xlsx_files to authenticated;

create function pg_temp.package_files(p_format text,p_codes text[] default array['shipment_workbook','cmr','ttn','packing_list']) returns jsonb language sql as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'generation_id',('fd600000-0000-4000-8000-00000000000'||n)::text,'document_id',document_id,'document_type_code',type_code,
  'title',label||' · XLSX-EXP-1','storage_path','documents/'||document_id||'/00000000000000000000000000000001-'||file_code||'.xlsx',
  'original_filename',label||'.xlsx','document_number','1','output_format',p_format,'checksum_sha256',repeat('a',64)) order by n),'[]'::jsonb)
 from xlsx_files where type_code=any(p_codes) $$;
grant execute on function pg_temp.package_files(text,text[]) to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','fd000000-0000-4000-8000-000000000001',false);

-- PDF is no longer accepted for the package types, nor is a PDF workbook.
do $$ declare v_message text; begin
 begin perform public.register_generated_document_package('fd400000-0000-4000-8000-000000000001','fd410000-0000-4000-8000-000000000001','fd300000-0000-4000-8000-000000000001',
   pg_temp.package_files('pdf',array['cmr']),false,'{}'::jsonb);
 exception when others then v_message:=sqlerrm; end;
 assert v_message like '%Недопустимое сочетание%','CMR as PDF must be rejected, got: '||coalesce(v_message,'no error');
 v_message:=null;
 begin perform public.register_generated_document_package('fd400000-0000-4000-8000-000000000001','fd410000-0000-4000-8000-000000000001','fd300000-0000-4000-8000-000000000001',
   pg_temp.package_files('pdf',array['shipment_workbook']),false,'{}'::jsonb);
 exception when others then v_message:=sqlerrm; end;
 assert v_message like '%Недопустимое сочетание%','workbook as PDF must be rejected';
 assert (select count(*) from public.documents where id::text like 'fd5%')=0,'a rejected package registers nothing';
end $$;

-- Prices stay behind their own permission even for XLSX outputs.
do $$ declare v_message text; begin
 begin perform public.register_generated_document_package('fd400000-0000-4000-8000-000000000001','fd410000-0000-4000-8000-000000000001','fd300000-0000-4000-8000-000000000001',
   pg_temp.package_files('xlsx',array['cmr']),false,'{"total_amount":"100"}'::jsonb);
 exception when others then v_message:=sqlerrm; end;
 assert v_message like '%Финансовые поля%','financial snapshot without the price flag must be rejected';
end $$;

-- The same type cannot appear twice.
do $$ declare v_message text; begin
 begin perform public.register_generated_document_package('fd400000-0000-4000-8000-000000000001','fd410000-0000-4000-8000-000000000001','fd300000-0000-4000-8000-000000000001',
   pg_temp.package_files('xlsx',array['cmr']) || pg_temp.package_files('xlsx',array['cmr']),false,'{}'::jsonb);
 exception when others then v_message:=sqlerrm; end;
 assert v_message like '%несколько раз%','duplicate types are rejected';
end $$;

-- The whole package registers in one call and is visible in the shipment card and the document register.
do $$ declare v_result jsonb; begin
 v_result:=public.register_generated_document_package('fd400000-0000-4000-8000-000000000001','fd410000-0000-4000-8000-000000000001','fd300000-0000-4000-8000-000000000001',
   pg_temp.package_files('xlsx'),false,'{"shipment_number":"XLSX-EXP-1"}'::jsonb);
 assert jsonb_array_length(v_result)=4,'four documents are registered';
 assert (select count(*) from public.document_generations where shipment_id='fd300000-0000-4000-8000-000000000001' and output_format='xlsx')=4,'each document gets its own provenance record';
 assert (select count(*) from public.document_links where entity_type='shipment' and entity_id='fd300000-0000-4000-8000-000000000001')=4,'documents are linked to the shipment';
 assert (select array_agg(t.code order by t.code) from public.documents d join public.document_types t on t.id=d.document_type_id where d.id::text like 'fd5%')
   =array['cmr','packing_list','shipment_workbook','ttn'],'document types match the package outputs';
end $$;

reset role;
rollback;
