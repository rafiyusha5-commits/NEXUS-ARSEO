-- Embedded-runner fixture, before migration 6200; synthetic data only.
insert into auth.users(id,email,raw_user_meta_data) values
 ('da000000-0000-4000-8000-000000000001','drive-owner@test.local','{"full_name":"Drive test"}'),
 ('da000000-0000-4000-8000-000000000002','drive-viewer@test.local','{"full_name":"Viewer test"}');
insert into public.user_roles(user_id,role_id)
 select 'da000000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator';
insert into public.user_roles(user_id,role_id)
 select 'da000000-0000-4000-8000-000000000002',id from public.app_roles where code='logistics_specialist';
insert into public.drive_catalog_files(file_id,name,folder_path,mime_type,ancestor_ids,source_modified_at,seen_run,content_status,text_method,ocr_attempts)
 values('Access_cleanup_doc','Audit','Audit','application/pdf',array['1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm'],'2026-10-11',gen_random_uuid(),'readable','ocr',2);
insert into public.drive_catalog_text(file_id,source_modified_at,body) values('Access_cleanup_doc','2026-10-11','пароль: OldSecret! Цена 247 EUR');
insert into public.agent_runs(id,user_id,channel,usage_date,budget_month,question_excerpt,tools,finish_token_hash)
 values('da000000-0000-4000-8000-000000000003','da000000-0000-4000-8000-000000000001','web','2026-10-11','2026-10-01','Цена 247 EUR',
 '[{"name":"find_drive_documents","params":{"query":"Цена 247 EUR"},"rows":1,"truncated":false,"ms":1}]',repeat('a',64));
select public.drive_catalog_sync_step('da000000-0000-4000-8000-000000000001','start');
select public.drive_catalog_sync_step('da000000-0000-4000-8000-000000000001','claim');
