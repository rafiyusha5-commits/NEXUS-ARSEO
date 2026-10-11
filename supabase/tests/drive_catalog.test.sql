\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('dc000000-0000-4000-8000-000000000001','catalog-admin@test.local','{"full_name":"Catalog admin"}'),
 ('dc000000-0000-4000-8000-000000000002','catalog-logistic@test.local','{"full_name":"Catalog viewer"}');
insert into public.user_roles(user_id,role_id) select 'dc000000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator';
insert into public.user_roles(user_id,role_id) select 'dc000000-0000-4000-8000-000000000002',id from public.app_roles where code='logistics_specialist';
create temp table catalog_receipts(n integer primary key,receipt jsonb);
grant all on catalog_receipts to service_role;
set role service_role;
insert into catalog_receipts values(1,public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','start'));
insert into catalog_receipts values(2,public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','claim'));
do $$declare c jsonb;begin
 select receipt into c from catalog_receipts where n=2;
 assert c->>'status'='scanning','first claim scans approved root';
 assert c->'item'->>'id'='1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm','root is fixed';
 assert public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','claim')->>'status'='busy','second worker cannot claim lease';
 begin perform public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','save_page','{}');raise exception 'missing receipt accepted' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert sqlerrm='DRIVE_BAD_CLAIM';end;
 perform public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','save_page',c||'{"files":[{"id":"Catalog_document_123","name":"ДС Belgian.pdf","mimeType":"application/pdf","size":"100","modifiedTime":"2026-10-11T00:00:00Z"}],"nextPage":""}');
 begin perform public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','save_page',c||'{"files":[],"nextPage":""}');raise exception 'duplicate receipt accepted' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert sqlerrm='DRIVE_BAD_CLAIM';end;
end$$;
insert into catalog_receipts values(3,public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','claim'));
do $$declare c jsonb;begin
 select receipt into c from catalog_receipts where n=3;
 assert c->>'status'='extracting','metadata scan is complete before text';
 assert c->'item'->>'id'='Catalog_document_123';
 perform public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','save_text',c||'{"status":"readable","text":"Декларация действительна до 31.12.2027. Кондитерские изделия. Цена 2 EUR.","truncated":false}');
 assert public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','claim')->>'status'='completed';
end$$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',true);
do $$begin
 assert (select count(*) from public.drive_catalog_files where file_id='Catalog_document_123')=1,'admin metadata RLS';
 assert (select count(*) from public.drive_catalog_text where file_id='Catalog_document_123')=1,'admin text RLS';
 assert public.search_drive_catalog('кондитерские',0)->>'total'='1','full text search';
 assert not has_function_privilege('authenticated','public.drive_catalog_sync_step(uuid,text,jsonb)','execute'),'employee cannot fabricate catalog';
 assert not has_table_privilege('authenticated','public.drive_catalog_text','insert'),'employee cannot inject text';
end$$;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000002',true);
do $$begin
 assert (select count(*) from public.drive_catalog_files)=0,'ordinary role cannot read archive';
 assert (select count(*) from public.drive_catalog_text)=0,'ordinary role cannot read text';
 assert public.search_drive_catalog('Belgian',0)->>'total'='0','RPC preserves RLS';
end$$;
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'dc000000-0000-4000-8000-000000000001',id,'deny','Catalog price deny test','dc000000-0000-4000-8000-000000000001' from public.permissions where code='prices.purchase.view';
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',true);
do $$begin
 assert (select count(*) from public.drive_catalog_files where file_id='Catalog_document_123')=1,'price deny does not hide permitted metadata';
 assert (select count(*) from public.drive_catalog_text)=0,'price deny hides potentially financial document text';
 assert public.search_drive_catalog('кондитерские',0)->>'total'='0','hidden body cannot be searched indirectly';
end$$;
reset role;
delete from public.user_permission_overrides where user_id='dc000000-0000-4000-8000-000000000001';
update public.drive_catalog_files set source_modified_at='2026-10-12T00:00:00Z' where file_id='Catalog_document_123';
set role authenticated;
do $$begin assert (select count(*) from public.drive_catalog_text)=0,'old version text hidden immediately';end$$;
reset role;
update public.profiles set is_active=false where id='dc000000-0000-4000-8000-000000000001';
set role service_role;
do $$begin
 begin perform public.drive_catalog_sync_step('dc000000-0000-4000-8000-000000000001','start');raise exception 'inactive owner accepted' using errcode='P0099';exception when sqlstate 'P0099' then raise;when insufficient_privilege then null;end;
end$$;
reset role;
rollback;
