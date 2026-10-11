\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('de000000-0000-4000-8000-000000000001','drive-ocr-admin@test.local','{"full_name":"OCR admin"}'),
 ('de000000-0000-4000-8000-000000000002','drive-ocr-logistic@test.local','{"full_name":"OCR logistic"}');
insert into public.user_roles(user_id,role_id) select 'de000000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator';
insert into public.user_roles(user_id,role_id) select 'de000000-0000-4000-8000-000000000002',id from public.app_roles where code='logistics_specialist';
insert into public.drive_catalog_files(file_id,name,folder_path,mime_type,ancestor_ids,source_modified_at,seen_run,content_status) values
 ('Ocr_pdf_document_123','ДС скан.pdf','Документы / ДС скан.pdf','application/pdf',array['1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm'],'2026-10-11T00:00:00Z',gen_random_uuid(),'needs_ocr'),
 ('Ocr_png_document_123','Фото.png','Фото / Фото.png','image/png',array['1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm'],'2026-10-11T00:00:00Z',gen_random_uuid(),'needs_ocr'),
 ('Ocr_other_document_123','Макет.cdr','Фото / Макет.cdr','image/x-coreldraw',array['1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm'],'2026-10-11T00:00:00Z',gen_random_uuid(),'needs_ocr');
create temp table ocr_receipts(n integer primary key,receipt jsonb);
grant all on ocr_receipts to service_role;
set role service_role;
do $$begin
 begin perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000002','start_ocr','{"mode":"ocr"}');raise exception 'unauthorized OCR start' using errcode='P0099';exception when insufficient_privilege then null;end;
 begin perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','start_ocr','{"mode":"ocr","batchSize":21}');raise exception 'unbounded OCR batch' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert sqlerrm='DRIVE_BAD_BATCH';end;
end$$;
insert into ocr_receipts values(1,public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','start_ocr','{"mode":"ocr","batchSize":5}'));
do $$begin
 assert public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','start')->>'status'='busy','normal sync cannot replace an active OCR queue';
 begin perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim');raise exception 'wrong mode consumed OCR' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert sqlerrm='DRIVE_BAD_MODE';end;
end$$;
insert into ocr_receipts values(2,public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}'));
do $$declare c jsonb;begin
 select receipt into c from ocr_receipts where n=2;
 assert c->'item'->>'id'='Ocr_pdf_document_123','PDF scans precede product images';
 assert public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}')->>'status'='busy','no concurrent recognition of a claimed source';
 begin perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','save_text',c||'{"mode":"ocr","status":"readable","text":"recognized","ocrConfidence":2,"ocrPages":1}');raise exception 'invalid confidence accepted' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert sqlerrm='DRIVE_BAD_OCR';end;
 perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','save_text',c||'{"mode":"ocr","status":"readable","text":"Декларация действительна до 31.12.2027","ocrConfidence":0.85,"ocrPages":1,"ocrError":null}');
 begin perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','save_text',c||'{"mode":"ocr","status":"readable","text":"duplicate","ocrPages":1}');raise exception 'duplicate receipt accepted' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert sqlerrm='DRIVE_BAD_CLAIM';end;
end$$;
insert into ocr_receipts values(3,public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}'));
do $$declare c jsonb;begin
 select receipt into c from ocr_receipts where n=3;
 assert c->'item'->>'id'='Ocr_png_document_123';
 perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','save_text',c||'{"mode":"ocr","status":"needs_ocr","text":"","ocrError":"empty"}');
 assert public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}')->>'status'='completed','unsupported image is not queued';
 perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','start_ocr','{"mode":"ocr"}');
 c:=public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}');
 assert c->'item'->>'id'='Ocr_png_document_123','readable files are not OCRed again';
 perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','save_text',c||'{"mode":"ocr","status":"error","text":"","ocrError":"provider_error"}');
 assert public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}')->>'status'='completed';
 perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','start_ocr','{"mode":"ocr"}');
 assert public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}')->>'status'='completed','failed source has at most two OCR attempts';
end$$;
reset role;
insert into public.drive_catalog_files(file_id,name,folder_path,mime_type,ancestor_ids,source_modified_at,seen_run,content_status) values
 ('Ocr_crash_document_123','После сбоя.png','Фото / После сбоя.png','image/png',array['1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm'],'2026-10-11T00:00:00Z',gen_random_uuid(),'needs_ocr');
set role service_role;
select public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','start_ocr','{"mode":"ocr"}');
select public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}');
reset role;
update private.drive_catalog_sync set lease_until=now()-interval '1 second' where id;
set role service_role;
select public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}');
reset role;
update private.drive_catalog_sync set lease_until=now()-interval '1 second' where id;
set role service_role;
do $$declare c jsonb;begin
 c:=public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}');
 assert (c->'item'->>'ocrExhausted')::boolean,'a twice-abandoned source is saved as failed without a third provider call';
 perform public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','save_text',c||'{"mode":"ocr","status":"error","text":"","ocrError":"retry_exhausted"}');
 assert public.drive_catalog_sync_step('de000000-0000-4000-8000-000000000001','claim','{"mode":"ocr"}')->>'status'='completed';
end$$;
reset role;
do $$begin
 assert (select ocr_attempts from public.drive_catalog_files where file_id='Ocr_pdf_document_123')=1;
 assert (select ocr_attempts from public.drive_catalog_files where file_id='Ocr_png_document_123')=2;
 assert (select text_method from public.drive_catalog_files where file_id='Ocr_pdf_document_123')='ocr';
 assert (select ocr_confidence from public.drive_catalog_files where file_id='Ocr_pdf_document_123')=.85;
 assert (select ocr_attempts from public.drive_catalog_files where file_id='Ocr_crash_document_123')=2;
 assert not has_function_privilege('authenticated','public.drive_catalog_sync_step(uuid,text,jsonb)','execute');
end$$;
set role authenticated;
select set_config('request.jwt.claim.sub','de000000-0000-4000-8000-000000000001',true);
do $$begin assert (select count(*) from public.drive_catalog_text where file_id='Ocr_pdf_document_123')=1;end$$;
select set_config('request.jwt.claim.sub','de000000-0000-4000-8000-000000000002',true);
do $$begin assert (select count(*) from public.drive_catalog_text where file_id='Ocr_pdf_document_123')=0,'OCR text retains archive and price RLS';end$$;
reset role;
rollback;
