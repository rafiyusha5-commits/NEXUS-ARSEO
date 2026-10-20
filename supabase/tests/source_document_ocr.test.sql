-- OCR for source documents (202609274900): permissions, idempotent re-runs, bounded retries, a lease
-- for running jobs, and the guarantee that OCR only proposes: it never confirms and never touches the shipment.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/finish_current_ocr.sql

insert into auth.users(id,email,raw_user_meta_data) values
 ('ff000000-0000-4000-8000-000000000001','ocr-director@test.local','{"full_name":"OCR Director"}'),
 ('ff000000-0000-4000-8000-000000000002','ocr-specialist@test.local','{"full_name":"OCR Specialist"}'),
 ('ff000000-0000-4000-8000-000000000003','ocr-denied@test.local','{"full_name":"OCR Denied"}'),
 ('ff000000-0000-4000-8000-000000000004','ocr-specialist-two@test.local','{"full_name":"OCR Specialist Two"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('ff000000-0000-4000-8000-000000000001','director'),
 ('ff000000-0000-4000-8000-000000000002','logistics_specialist'),
 ('ff000000-0000-4000-8000-000000000003','logistics_specialist'),
 ('ff000000-0000-4000-8000-000000000004','logistics_specialist')) u(id,role_code) join public.app_roles r on r.code=u.role_code;
-- This specialist keeps every other permission but is personally denied the right to send documents to OCR.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ff000000-0000-4000-8000-000000000003',id,'deny','OCR test','ff000000-0000-4000-8000-000000000001' from public.permissions where code='source_documents.ocr';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ff100000-0000-4000-8000-000000000001',array['customer'],'OCR customer','KZ','OCR-A');

set session_replication_role=replica;
insert into public.shipments(id,shipment_number,type,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'ff300000-0000-4000-8000-000000000001','OCR-EXP-1','export','ff100000-0000-4000-8000-000000000001',
 (select id from public.routes limit 1),(select id from public.process_templates limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where code='AKT'),'ff000000-0000-4000-8000-000000000001','ff000000-0000-4000-8000-000000000001';
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select d.id::uuid,t.id,'Scan '||d.n,'approved','manual_upload','ff000000-0000-4000-8000-000000000001',1
from (values ('ff200000-0000-4000-8000-000000000001','1'),('ff200000-0000-4000-8000-000000000002','2')) d(id,n) cross join (select id from public.document_types where code='driver_document') t;
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select ('ff21000'||n||'-0000-4000-8000-000000000001')::uuid,('ff20000'||'0-0000-4000-8000-00000000000'||n)::uuid,1,
 'documents/ff200000-0000-4000-8000-00000000000'||n||'/00000000000000000000000000000001-scan'||n||'.jpg','scan'||n||'.jpg','image/jpeg',10,true,'ff000000-0000-4000-8000-000000000001'
from (values (1),(2)) v(n);
-- only the first document is linked to the shipment
insert into public.document_links(document_id,entity_type,entity_id,created_by)
values('ff200000-0000-4000-8000-000000000001','shipment','ff300000-0000-4000-8000-000000000001','ff000000-0000-4000-8000-000000000001');
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

create function pg_temp.begin_ocr(p_sha text,p_provider text default 'fake',p_version text default 'fake-1',p_force boolean default false,p_doc text default 'ff200000-0000-4000-8000-000000000001')
returns jsonb language sql as $$
 select public.begin_shipment_source_ocr('ff300000-0000-4000-8000-000000000001',p_doc::uuid,
  case when p_doc like '%0001' then 'ff210001-0000-4000-8000-000000000001' else 'ff210002-0000-4000-8000-000000000001' end::uuid,
  'driver_document',p_sha,p_provider,p_version,3,300,p_force) $$;
grant execute on function pg_temp.begin_ocr(text,text,text,boolean,text) to authenticated;

create temp table shipment_before as select to_jsonb(s) as row_data,(select count(*) from public.shipment_transports) as transports from public.shipments s where id='ff300000-0000-4000-8000-000000000001';
grant select on shipment_before to authenticated;
create temp table ocr_ids(name text primary key,id uuid);
grant select,insert,update on ocr_ids to authenticated;

-- ---------- permissions ----------
set role authenticated;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000003',false);
select pg_temp.fails($$select pg_temp.begin_ocr(repeat('a',64))$$,'Нет права передавать документы на OCR');
do $$ begin assert (select count(*) from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001')=0,'a denied user creates no row'; end $$;

reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000002',false);
set role authenticated;
-- the other document is not linked to the shipment
select pg_temp.fails($$select pg_temp.begin_ocr(repeat('a',64),'fake','fake-1',false,'ff200000-0000-4000-8000-000000000002')$$,'не связан с этой поставкой');
select pg_temp.fails($$select pg_temp.begin_ocr('not-a-checksum')$$,'контрольная сумма');
select pg_temp.fails($$select pg_temp.begin_ocr(repeat('a',64),'')$$,'провайдер');

-- ---------- claim, lease, finish ----------
do $$ declare v jsonb; begin
 v:=pg_temp.begin_ocr(repeat('a',64));
 assert v->>'action'='run' and (v->>'attempt')::int=1,'first claim runs';
 insert into ocr_ids values('main',(v->>'extraction_id')::uuid);
 assert (select status from public.shipment_source_extractions where id=(select id from ocr_ids where name='main'))='pending','the claimed job is pending (Обрабатывается)';
 assert (select extraction_method||ocr_provider||ocr_provider_version||source_sha256 from public.shipment_source_extractions where id=(select id from ocr_ids where name='main'))='ocrfakefake-1'||repeat('a',64),'method, provider, version and checksum are stored';
 v:=pg_temp.begin_ocr(repeat('a',64));
 assert v->>'action'='busy','a second request while the job runs does not start another one';
 assert (select attempt_count from public.shipment_source_extractions where id=(select id from ocr_ids where name='main'))=1,'busy does not spend an attempt';
end $$;

-- a reviewer cannot confirm a document that is still being processed
reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000001',false);
set role authenticated;
select pg_temp.fails($$select public.confirm_shipment_source_extraction((select id from ocr_ids where name='main'))$$,'не найден или закрыт');
reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000002',false);
set role authenticated;

-- only the user holding the lease can finish it
reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000004',false);
set role authenticated;
select pg_temp.fails($$select pg_temp.finish_current_ocr((select id from ocr_ids where name='main'),'extracted','{"vehicle_plate":"X"}','{}','[]',null,'ocr-rules-v1',1,100,0.9)$$,'запущено другим пользователем');

reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000002',false);
set role authenticated;
-- the result can never be 'confirmed' directly
select pg_temp.fails($$select pg_temp.finish_current_ocr((select id from ocr_ids where name='main'),'confirmed','{"vehicle_plate":"X"}','{}','[]',null,'ocr-rules-v1',1,100,0.9)$$,'Некорректный статус');
select pg_temp.fails($$select pg_temp.finish_current_ocr((select id from ocr_ids where name='main'),'extracted','{}','{}','[]',null,'ocr-rules-v1',1,100,1.5)$$,'уверенност');
do $$ begin
 perform pg_temp.finish_current_ocr((select id from ocr_ids where name='main'),'needs_review','{"vehicle_plate":"000TST00"}',
  '{"vehicle_plate":{"label":"Госномер","value":"000TST00","confidence":0.55,"method":"ocr"}}','[]',null,'ocr-rules-v1',2,1500,0.812,'driver_document');
 assert (select status from public.shipment_source_extractions where id=(select id from ocr_ids where name='main'))='needs_review','result waits for review (Нужна проверка)';
 assert (select ocr_page_count=2 and processing_ms=1500 and ocr_confidence=0.812 and processing_finished_at is not null and confirmed_data='{}'::jsonb and reviewed_by is null from public.shipment_source_extractions where id=(select id from ocr_ids where name='main')),'metadata stored, nothing confirmed';
 assert (select field_evidence->'vehicle_plate'->>'confidence' from public.shipment_source_extractions where id=(select id from ocr_ids where name='main'))='0.55','confidence per field is stored';
end $$;
-- finishing twice is refused
select pg_temp.fails($$select pg_temp.finish_current_ocr((select id from ocr_ids where name='main'),'extracted','{}','{}','[]',null,'ocr-rules-v1',1,1,0.9)$$,'уже завершено');

-- ---------- idempotency ----------
do $$ declare v jsonb; begin
 v:=pg_temp.begin_ocr(repeat('a',64));
 assert v->>'action'='reuse','same bytes, provider and version reuse the stored result';
 assert (select status from public.shipment_source_extractions where id=(select id from ocr_ids where name='main'))='needs_review','reuse leaves the result in place';
 v:=pg_temp.begin_ocr(repeat('b',64));
 assert v->>'action'='run' and (v->>'attempt')::int=1,'different bytes are a new job';
 perform pg_temp.finish_current_ocr((v->>'extraction_id')::uuid,'extracted','{"vehicle_plate":"1"}','{}','[]',null,'ocr-rules-v1',1,10,0.9);
 v:=pg_temp.begin_ocr(repeat('b',64),'fake','fake-2');
 assert v->>'action'='run','a new provider version re-recognises';
 perform pg_temp.finish_current_ocr((v->>'extraction_id')::uuid,'extracted','{"vehicle_plate":"1"}','{}','[]',null,'ocr-rules-v1',1,10,0.9);
 assert (select count(*) from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001')=1,'one row per document version however many times it ran';
end $$;

-- ---------- bounded retries ----------
do $$ declare v jsonb; begin
 for i in 1..3 loop
  v:=pg_temp.begin_ocr(repeat('c',64));
  assert v->>'action'='run' and (v->>'attempt')::int=i,'attempt '||i;
  perform pg_temp.finish_current_ocr((v->>'extraction_id')::uuid,'failed','{}','{}','[]','Сервис распознавания не ответил вовремя','ocr-rules-v1',null,30000,null);
 end loop;
 v:=pg_temp.begin_ocr(repeat('c',64));
 assert v->>'action'='exhausted','after the limit the job stops instead of retrying forever';
 assert (select attempt_count from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001')=3,'no further attempt is spent';
 assert (select error_message from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001')='Сервис распознавания не ответил вовремя','the reason stays visible (Не прочитано)';
end $$;
-- going beyond the limit is a reviewer's decision
select pg_temp.fails($$select pg_temp.begin_ocr(repeat('c',64),'fake','fake-1',true)$$,'проверяющий');

reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000001',false);
set role authenticated;
do $$ declare v jsonb; begin
 v:=pg_temp.begin_ocr(repeat('c',64),'fake','fake-1',true);
 assert v->>'action'='run' and (v->>'attempt')::int=1,'a reviewer can force one more run and the counter restarts';
 perform pg_temp.finish_current_ocr((v->>'extraction_id')::uuid,'extracted','{"vehicle_plate":"000TST00"}','{}','[]',null,'ocr-rules-v1',1,900,0.95);
end $$;

-- ---------- abandoned job: the lease expires and another user may take it over ----------
reset role;
update public.shipment_source_extractions set status='pending',processing_started_at=now()-interval '2 hours',requested_by='ff000000-0000-4000-8000-000000000002',attempt_count=1
 where shipment_id='ff300000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000004',false);
set role authenticated;
do $$ declare v jsonb; begin
 v:=pg_temp.begin_ocr(repeat('c',64));
 assert v->>'action'='run','an expired lease is taken over';
 assert (select requested_by from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001')='ff000000-0000-4000-8000-000000000004','the new holder owns the job';
end $$;
reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000002',false);
set role authenticated;
select pg_temp.fails($$select pg_temp.finish_current_ocr((select id from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001'),'extracted','{"vehicle_plate":"late"}','{}','[]',null,'ocr-rules-v1',1,1,0.9)$$,'запущено другим пользователем');

-- ---------- recorded outcomes are never overwritten by text recognition, and nothing can be written as confirmed ----------
reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000004',false);
set role authenticated;
select pg_temp.fails($$select public.upsert_shipment_source_extraction('ff300000-0000-4000-8000-000000000001','ff200000-0000-4000-8000-000000000001','ff210001-0000-4000-8000-000000000001','driver_document','confirmed','{"vehicle_plate":"X"}')$$,'Некорректный статус');
do $$ begin
 -- finish the takeover job, then let a reviewer confirm it
 perform pg_temp.finish_current_ocr((select id from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001'),'extracted','{"vehicle_plate":"000TST00"}','{}','[]',null,'ocr-rules-v1',1,500,0.95);
end $$;
reset role;
select set_config('request.jwt.claim.sub','ff000000-0000-4000-8000-000000000001',false);
set role authenticated;
do $$ declare v jsonb; begin
 perform public.confirm_shipment_source_extraction((select id from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001'));
 assert (select status from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001')='confirmed','employee confirmation works';
 v:=pg_temp.begin_ocr(repeat('d',64),'other','other-1',true);
 assert v->>'action'='run','a reviewer can withdraw an incorrect confirmation and run OCR again';
 assert (select status='pending' and confirmed_data='{}'::jsonb and reviewed_by is null and reviewed_at is null
  from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001'),
  'forced re-recognition clears only the old extraction review';
 perform public.upsert_shipment_source_extraction('ff300000-0000-4000-8000-000000000001','ff200000-0000-4000-8000-000000000001','ff210001-0000-4000-8000-000000000001','driver_document','extracted','{"vehicle_plate":"changed"}');
 assert (select status from public.shipment_source_extractions where shipment_id='ff300000-0000-4000-8000-000000000001')='pending','text recognition cannot overwrite the active OCR job';
end $$;

-- ---------- OCR never writes to the shipment ----------
reset role;
do $$ begin
 assert (select to_jsonb(s) from public.shipments s where id='ff300000-0000-4000-8000-000000000001')=(select row_data from shipment_before),'the shipment row is untouched by OCR';
 assert (select count(*) from public.shipment_transports)=(select transports from shipment_before),'no transport was created or changed';
 assert not exists(select 1 from pg_proc p where p.proname in ('begin_shipment_source_ocr','finish_shipment_source_ocr') and p.prosrc ~* '(update|insert into)\s+public\.(shipments|shipment_transports|vehicles|carriers)'),'OCR functions contain no write to shipment tables';
end $$;

-- ---------- grants ----------
do $$ begin
 assert has_function_privilege('authenticated','public.begin_shipment_source_ocr(uuid,uuid,uuid,text,text,text,text,integer,integer,boolean)','execute');
 assert not has_function_privilege('anon','public.begin_shipment_source_ocr(uuid,uuid,uuid,text,text,text,text,integer,integer,boolean)','execute'),'anonymous cannot start OCR';
 assert not has_function_privilege('service_role','public.finish_shipment_source_ocr(uuid,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text)','execute'),'service role cannot bypass the permission checks';
 assert (select count(*) from public.role_permissions rp join public.permissions p on p.id=rp.permission_id where p.code='source_documents.ocr' and rp.granted)>=1,'the OCR permission is granted to operating roles';
end $$;

rollback;
\echo 'source_document_ocr: all checks passed'
