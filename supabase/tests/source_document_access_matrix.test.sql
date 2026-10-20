-- Access matrix of the source-document block: logistics specialist, senior logistics manager, director and an
-- external client against every operation, the reset / re-recognition flow, document conflicts, and the
-- guarantee that nothing reaches the shipment before an employee confirms it. Every cell is executed for real.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/finish_current_ocr.sql

insert into auth.users(id,email,raw_user_meta_data) values
 ('e9000000-0000-4000-8000-000000000001','mx-logist@test.local','{"full_name":"MX Logist"}'),
 ('e9000000-0000-4000-8000-000000000002','mx-senior@test.local','{"full_name":"MX Senior"}'),
 ('e9000000-0000-4000-8000-000000000003','mx-director@test.local','{"full_name":"MX Director"}'),
 ('e9000000-0000-4000-8000-000000000004','mx-client@test.local','{"full_name":"MX External client"}'),
 ('e9000000-0000-4000-8000-000000000005','mx-admin@test.local','{"full_name":"MX Admin"}');
insert into public.user_roles(user_id,role_id) select v.u::uuid,r.id from (values
 ('e9000000-0000-4000-8000-000000000001','logistics_specialist'),('e9000000-0000-4000-8000-000000000002','senior_logistics_manager'),
 ('e9000000-0000-4000-8000-000000000003','director'),('e9000000-0000-4000-8000-000000000005','administrator')) v(u,code) join public.app_roles r on r.code=v.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('e9100000-0000-4000-8000-000000000001',array['customer'],'MX customer','KZ','MX-A');

set role authenticated;
select set_config('request.jwt.claim.sub','e9000000-0000-4000-8000-000000000005',false);
select public.configure_external_client('e9000000-0000-4000-8000-000000000004','e9100000-0000-4000-8000-000000000001','MX client',null,'ru',true,true,true);
reset role;

set session_replication_role=replica;
insert into public.shipments(id,shipment_number,type,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'e9300000-0000-4000-8000-000000000001','MX-EXP-1','export','e9100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates limit 1),
 (select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),'e9000000-0000-4000-8000-000000000003','e9000000-0000-4000-8000-000000000003';
insert into public.shipment_transports(id,shipment_id,sequence_no,status) values('e9600000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001',1,'planned');
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select ('e9200000-0000-4000-8000-00000000000'||n)::uuid,t.id,'Doc '||n,'approved','manual_upload','e9000000-0000-4000-8000-000000000003',1 from generate_series(1,3) n cross join (select id from public.document_types where code='driver_document') t;
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select ('e921000'||n||'-0000-4000-8000-000000000001')::uuid,('e9200000-0000-4000-8000-00000000000'||n)::uuid,1,
 'documents/e9200000-0000-4000-8000-00000000000'||n||'/00000000000000000000000000000001-d'||n||'.jpg','d'||n||'.jpg','image/jpeg',10,true,'e9000000-0000-4000-8000-000000000003' from generate_series(1,3) n;
insert into public.document_links(document_id,entity_type,entity_id,created_by)
select ('e9200000-0000-4000-8000-00000000000'||n)::uuid,'shipment','e9300000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000003' from generate_series(1,3) n;
set session_replication_role=origin;

-- Runs p_sql as the user (role authenticated) and returns 'ok' or the error text; always drops back to the owner.
create function pg_temp.attempt(p_user text,p_sql text) returns text language plpgsql as $$
declare v text;
begin
 perform set_config('request.jwt.claim.sub',p_user,true);
 perform set_config('role','authenticated',true);
 begin execute p_sql; v:='ok'; exception when others then v:=sqlerrm; end;
 perform set_config('role','none',true);
 return v;
end $$;
create function pg_temp.visible(p_user text) returns bigint language plpgsql as $$
declare v bigint;
begin
 perform set_config('request.jwt.claim.sub',p_user,true);
 perform set_config('role','authenticated',true);
 select count(*) into v from public.shipment_source_extractions;
 perform set_config('role','none',true);
 return v;
end $$;
create function pg_temp.expect(p_label text,p_actual text,p_expected text) returns void language plpgsql as $$
begin
 if p_expected='ok' then
  if p_actual<>'ok' then raise exception '%: expected success, got: %',p_label,p_actual; end if;
 elsif p_actual !~* p_expected then raise exception '%: expected an error matching %, got: %',p_label,p_expected,p_actual;
 end if;
end $$;

create temp table u(name text primary key,id text);
insert into u values('logist','e9000000-0000-4000-8000-000000000001'),('senior','e9000000-0000-4000-8000-000000000002'),('director','e9000000-0000-4000-8000-000000000003'),('client','e9000000-0000-4000-8000-000000000004');

create function pg_temp.upsert_sql(p_n integer,p_status text,p_data text,p_conflicts text default '[]') returns text language sql as $$
 select format($f$select public.upsert_shipment_source_extraction('e9300000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-00000000000%s','e921000%s-0000-4000-8000-000000000001','driver_document',%L,%L::jsonb,'{}'::jsonb,%L::jsonb)$f$,p_n,p_n,p_status,p_data,p_conflicts) $$;
create function pg_temp.begin_sql(p_n integer,p_hash text,p_force boolean default false) returns text language sql as $$
 select format($f$select public.begin_shipment_source_ocr('e9300000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-00000000000%s','e921000%s-0000-4000-8000-000000000001','driver_document',%L,'fake','fake-1',3,300,%L::boolean)$f$,p_n,p_n,repeat(p_hash,64),p_force) $$;
create function pg_temp.finish_sql(p_n integer,p_status text,p_data text) returns text language sql as $$
 select format($f$select pg_temp.finish_current_ocr((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-00000000000%s'),%L,%L::jsonb,'{}'::jsonb,'[]'::jsonb,null,'ocr-rules-v1',1,100,0.9)$f$,p_n,p_status,p_data) $$;
create function pg_temp.row_status(p_n integer) returns text language sql as $$
 select status from public.shipment_source_extractions where document_id=('e9200000-0000-4000-8000-00000000000'||p_n)::uuid $$;
create function pg_temp.driver() returns text language sql as $$select coalesce(driver_name,'<none>') from public.shipment_transports where id='e9600000-0000-4000-8000-000000000001'$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ===== 1. text-layer proposal: staff may write one, an external client may not =====
do $$ declare r record; begin
 for r in select * from u order by name loop
  perform pg_temp.expect('upsert by '||r.name,pg_temp.attempt(r.id,pg_temp.upsert_sql(1,'extracted','{"driver_name":"Иванов"}')),case r.name when 'client' then 'Нет права распознавать' else 'ok' end);
 end loop;
 assert pg_temp.driver()='<none>','a proposal never reaches the shipment';
end $$;

-- ===== 2. who can read the proposals =====
do $$ declare r record; begin
 for r in select * from u loop
  assert pg_temp.visible(r.id)=case r.name when 'client' then 0 else 1 end,'visibility for '||r.name;
 end loop;
end $$;

-- ===== 3. OCR: claim and finish by staff only; the result can never be confirmed or written to the shipment =====
do $$ begin
 perform pg_temp.expect('client OCR claim',pg_temp.attempt((select id from u where name='client'),pg_temp.begin_sql(2,'a')),'Нет права');
 perform pg_temp.expect('logist OCR claim',pg_temp.attempt((select id from u where name='logist'),pg_temp.begin_sql(2,'a')),'ok');
 perform pg_temp.expect('client finish',pg_temp.attempt((select id from u where name='client'),pg_temp.finish_sql(2,'extracted','{}')),'Нет права');
 perform pg_temp.expect('senior cannot finish the logist job',pg_temp.attempt((select id from u where name='senior'),pg_temp.finish_sql(2,'extracted','{"driver_name":"Петров"}')),'запущено другим пользователем');
 perform pg_temp.expect('finish as confirmed',pg_temp.attempt((select id from u where name='logist'),pg_temp.finish_sql(2,'confirmed','{"driver_name":"Петров"}')),'Некорректный статус');
 perform pg_temp.expect('logist finish',pg_temp.attempt((select id from u where name='logist'),pg_temp.finish_sql(2,'extracted','{"driver_name":"Петров"}')),'ok');
 assert pg_temp.row_status(2)='extracted' and pg_temp.driver()='<none>','OCR result waits for review; the shipment is untouched';
end $$;

-- ===== 4. confirmation is a reviewer's act =====
do $$ begin
 perform pg_temp.expect('logist cannot confirm',pg_temp.attempt((select id from u where name='logist'),format($f$select public.confirm_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000002'))$f$)),'Нет права подтверждать');
 perform pg_temp.expect('client cannot confirm',pg_temp.attempt((select id from u where name='client'),format($f$select public.confirm_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000002'))$f$)),'Нет права подтверждать');
 perform pg_temp.expect('logist cannot review',pg_temp.attempt((select id from u where name='logist'),format($f$select public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000002'),'{"driver_name":"Петров"}'::jsonb,true)$f$)),'Нет права подтверждать');
 perform pg_temp.expect('client cannot review',pg_temp.attempt((select id from u where name='client'),format($f$select public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000002'),'{"driver_name":"Петров"}'::jsonb,true)$f$)),'Нет права подтверждать');
 assert pg_temp.row_status(2)='extracted' and pg_temp.driver()='<none>','refused attempts change nothing';
 perform pg_temp.expect('senior confirms',pg_temp.attempt((select id from u where name='senior'),format($f$select public.confirm_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000002'))$f$)),'ok');
 assert pg_temp.row_status(2)='confirmed','confirmed by the senior manager';
 assert pg_temp.driver()='<none>','even a confirmed proposal is not applied to the shipment until the reviewer chooses to apply it';
end $$;

-- ===== 5. applying to the shipment: only a reviewer who may edit shipments, only on request =====
do $$ begin
 perform pg_temp.expect('director confirms without applying',pg_temp.attempt((select id from u where name='director'),format($f$select public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000001'),null,false)$f$)),'ok');
 assert pg_temp.driver()='<none>','confirmation without "apply" leaves the shipment alone';
 perform pg_temp.expect('director applies',pg_temp.attempt((select id from u where name='director'),format($f$select public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000001'),null,true)$f$)),'ok');
 assert pg_temp.driver()='Иванов','the confirmed value is written once the reviewer applies it';
end $$;

-- ===== 6. reset and re-recognition of a confirmed result =====
do $$ begin
 perform pg_temp.expect('re-run without force reuses the confirmed result',pg_temp.attempt((select id from u where name='logist'),pg_temp.begin_sql(2,'a')),'ok');
 assert pg_temp.row_status(2)='confirmed','a plain re-run never touches a confirmed result';
 perform pg_temp.expect('logist cannot force',pg_temp.attempt((select id from u where name='logist'),pg_temp.begin_sql(2,'b',true)),'проверяющий');
 perform pg_temp.expect('client cannot force',pg_temp.attempt((select id from u where name='client'),pg_temp.begin_sql(2,'b',true)),'Нет права');
 assert pg_temp.row_status(2)='confirmed','refused resets change nothing';
 perform pg_temp.expect('senior resets and re-runs',pg_temp.attempt((select id from u where name='senior'),pg_temp.begin_sql(2,'b',true)),'ok');
 assert pg_temp.row_status(2)='pending','the confirmation is withdrawn while the document is recognised again';
 assert (select confirmed_data='{}'::jsonb and reviewed_by is null and reviewed_at is null from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000002'),'the old review is cleared';
 assert pg_temp.driver()='Иванов','a reset does not roll back what was applied earlier from another document';
 perform pg_temp.expect('senior finishes the new result',pg_temp.attempt((select id from u where name='senior'),pg_temp.finish_sql(2,'needs_review','{"driver_name":"Сидоров"}')),'ok');
 assert pg_temp.row_status(2)='needs_review' and pg_temp.driver()='Иванов','the new result waits for review and changes nothing';
end $$;

-- ===== 7. conflicting documents: the conflict is stored and review stays with the employee =====
do $$ begin
 perform pg_temp.expect('logist stores a conflicting proposal',pg_temp.attempt((select id from u where name='logist'),pg_temp.upsert_sql(3,'needs_review','{"vehicle_plate":"754BA04"}','[{"field":"vehicle_plate","values":["754ba04","755ba04"],"documents":["a","b"]}]')),'ok');
 assert (select jsonb_array_length(conflicts)=1 and status='needs_review' from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000003'),'the conflict is kept with the proposal';
 perform pg_temp.expect('the employee corrects the value while confirming',pg_temp.attempt((select id from u where name='senior'),format($f$select public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000003'),'{"vehicle_plate":"755BA04"}'::jsonb,false)$f$)),'ok');
 assert (select confirmed_data->>'vehicle_plate' from public.shipment_source_extractions where document_id='e9200000-0000-4000-8000-000000000003')='755BA04','the confirmed value is the one the employee typed, not the proposal';
end $$;

-- ===== 8. an external client has no way in: not by RPC, not by the table =====
do $$ declare c text:=(select id from u where name='client'); begin
 perform pg_temp.expect('client insert',pg_temp.attempt(c,$f$insert into public.shipment_source_extractions(shipment_id,document_id,document_version_id,source_kind,extractor_version) values('e9300000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','e9210001-0000-4000-8000-000000000001','other','x')$f$),'permission denied');
 perform pg_temp.expect('client update',pg_temp.attempt(c,$f$update public.shipment_source_extractions set status='confirmed'$f$),'permission denied');
 perform pg_temp.expect('client delete',pg_temp.attempt(c,$f$delete from public.shipment_source_extractions$f$),'permission denied');
 assert pg_temp.visible(c)=0,'the client sees no proposals';
 assert not exists(select 1 from public.shipment_source_extractions where status='confirmed' and reviewed_by='e9000000-0000-4000-8000-000000000004'),'nothing was confirmed on behalf of the client';
end $$;

-- ===== 9. staff cannot write the table directly either =====
do $$ begin
 perform pg_temp.expect('director direct update',pg_temp.attempt((select id from u where name='director'),$f$update public.shipment_source_extractions set status='confirmed'$f$),'permission denied');
 perform pg_temp.expect('director direct insert',pg_temp.attempt((select id from u where name='director'),$f$insert into public.shipment_source_extractions(shipment_id,document_id,document_version_id,source_kind,extractor_version) values('e9300000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','e9210001-0000-4000-8000-000000000001','other','x')$f$),'permission denied');
end $$;

rollback;
\echo 'source_document_access_matrix: all checks passed'
