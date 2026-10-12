\set ON_ERROR_STOP 1
begin;
-- Standalone native runner: install fixtures inside this transaction if absent.
insert into auth.users(id,email,raw_user_meta_data) values
 ('da000000-0000-4000-8000-000000000001','drive-owner@test.local','{"full_name":"Drive test"}'),
 ('da000000-0000-4000-8000-000000000002','drive-viewer@test.local','{"full_name":"Viewer test"}') on conflict do nothing;
insert into public.user_roles(user_id,role_id)
 select 'da000000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator' on conflict do nothing;
insert into public.user_roles(user_id,role_id)
 select 'da000000-0000-4000-8000-000000000002',id from public.app_roles where code='logistics_specialist' on conflict do nothing;
do $$begin
 assert not exists(select 1 from public.drive_catalog_text where body like '%OldSecret%'),'legacy text purged';
 assert not exists(select 1 from private.drive_catalog_sync where token is not null),'legacy receipts invalidated';
 assert not exists(select 1 from public.drive_catalog_runs where status in ('scanning','extracting')),'legacy workers cancelled';
 assert not exists(select 1 from public.drive_catalog_files where file_id='Access_cleanup_doc' and (content_status<>'needs_ocr' or ocr_attempts<>0)),'legacy OCR eligible for fresh recognition';
 assert not exists(select 1 from public.agent_runs where question_excerpt is not null),'questions purged';
 assert not exists(select 1 from public.agent_runs a cross join lateral jsonb_array_elements(a.tools) e where e->'params'<>'{}'::jsonb),'params purged';
 assert not has_table_privilege('service_role','public.drive_catalog_text','select'),'no new service_role text access';
 assert not has_table_privilege('service_role','public.drive_catalog_files','select'),'no new service_role metadata access';
 assert not has_function_privilege('authenticated','public.drive_catalog_sync_step(uuid,text,jsonb)','execute'),'client cannot fabricate source catalog';
 assert not has_table_privilege('authenticated','private.drive_gateway_config','select'),'gateway hash private';
 assert not has_table_privilege('service_role','private.drive_gateway_config','select'),'gateway hash not service data';
end$$;
insert into private.drive_gateway_config(id,secret_sha256) values(true,encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'))
 on conflict(id) do update set secret_sha256=excluded.secret_sha256;
insert into public.drive_catalog_files(file_id,name,folder_path,mime_type,ancestor_ids,source_modified_at,seen_run,content_status,text_method)
 values('Access_secured_doc','Catalog','Catalog','application/pdf',array['1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm'],'2026-10-11',gen_random_uuid(),'readable','ocr');
insert into public.drive_catalog_text(file_id,source_modified_at,body) values('Access_secured_doc','2026-10-11','обработанный документ 247 EUR');
set role authenticated;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000001',true);
select set_config('request.headers','{}',true);
do $$begin
 assert (select count(*) from public.drive_catalog_files)=0,'JWT alone cannot query stale metadata';
 assert (select count(*) from public.drive_catalog_text)=0,'JWT alone cannot read cached text';
 assert public.search_drive_catalog('обработанный')->>'total'='0','direct RPC cannot search cached body';
end$$;
select set_config('request.headers','{"x-nexus-drive-gateway":"forged"}',true);
do $$begin assert (select count(*) from public.drive_catalog_text)=0,'forged gate denied';end$$;
select set_config('request.headers',jsonb_build_object('x-nexus-drive-gateway',repeat('b',64))::text,true);
do $$begin assert (select count(*) from public.drive_catalog_text)=0,'well-shaped wrong secret denied';end$$;
select set_config('request.headers',jsonb_build_object('x-nexus-drive-gateway',repeat('a',64))::text,true);
do $$begin
 assert (select count(*) from public.drive_catalog_text where file_id='Access_secured_doc')=1,'gateway AND employee RLS permit read';
 assert public.search_drive_catalog('обработанный')->>'total'='1','full text preserved behind gateway';
 assert public.search_drive_catalog('обработанный')->>'textSearch'='true','capture text authority with search snapshot';
end$$;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000002',true);
do $$begin assert (select count(*) from public.drive_catalog_text)=0,'gateway alone does not grant employee permissions';end$$;
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'da000000-0000-4000-8000-000000000001',id,'deny','Access regression','da000000-0000-4000-8000-000000000001' from public.permissions where code='prices.purchase.view';
set role authenticated;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000001',true);
do $$begin
 assert (select count(*) from public.drive_catalog_text)=0,'price deny overrides valid gateway';
 assert public.search_drive_catalog('обработанный')->>'total'='0','no hidden text inference';
 assert public.search_drive_catalog('обработанный')->>'textSearch'='false','denied text is not available to search';
 assert (select count(*) from public.drive_catalog_files where file_id='Access_secured_doc')=1,'metadata permission preserved';
end$$;
reset role;
-- Trigger protects both old workers and new application code; accounting survives.
insert into public.agent_runs(id,user_id,channel,usage_date,budget_month,question_excerpt,tools,finish_token_hash,input_tokens)
 values('da000000-0000-4000-8000-000000000004','da000000-0000-4000-8000-000000000001','web','2026-10-11','2026-10-01','Цена 247 EUR',
 '[{"name":"get_drive_document","params":{"drive_id":"Copied_secret"},"rows":1,"truncated":false,"ms":1}]',repeat('a',64),321);
do $$begin
 assert (select question_excerpt is null and tools->0->'params'='{}'::jsonb and input_tokens=321 from public.agent_runs where id='da000000-0000-4000-8000-000000000004'),'future traces contain no parameters/questions';
end$$;
rollback;
