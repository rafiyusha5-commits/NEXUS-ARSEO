-- Agent «Сверка» (202609276400): rules, access, notifications once per problem,
-- daily run for service_role only, and no writes into shipments, vehicles, documents or extractions.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('dc000000-0000-4000-8000-000000000001','dc-director@test.local','{"full_name":"DC Director"}'),
 ('dc000000-0000-4000-8000-000000000002','dc-logistics@test.local','{"full_name":"DC Logistics"}'),
 ('dc000000-0000-4000-8000-000000000003','dc-accountant@test.local','{"full_name":"DC Accountant"}'),
 ('dc000000-0000-4000-8000-000000000004','dc-nodocs@test.local','{"full_name":"DC No documents"}'),
 ('dc000000-0000-4000-8000-000000000005','dc-admin@test.local','{"full_name":"DC Administrator"}');
insert into public.user_roles(user_id,role_id) select v.u::uuid,r.id from (values
 ('dc000000-0000-4000-8000-000000000001','director'),('dc000000-0000-4000-8000-000000000002','logistics_specialist'),
 ('dc000000-0000-4000-8000-000000000003','accountant'),('dc000000-0000-4000-8000-000000000004','senior_logistics_manager'),
 ('dc000000-0000-4000-8000-000000000005','administrator')) v(u,code)
 join public.app_roles r on r.code=v.code;
-- The accountant may see shipments and documents but is not a recipient by role.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select x.u::uuid,p.id,x.effect,'document check test','dc000000-0000-4000-8000-000000000001' from (values
 ('dc000000-0000-4000-8000-000000000003','shipments.view','allow'),('dc000000-0000-4000-8000-000000000003','documents.view','allow'),
 ('dc000000-0000-4000-8000-000000000004','documents.view','deny')) x(u,code,effect) join public.permissions p on p.code=x.code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('dc100000-0000-4000-8000-000000000001',array['customer'],'DC customer','KZ','DC-A'),
 ('dc100000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'DC maker','FI','DC-B');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('dc200000-0000-4000-8000-000000000001','DC-001','{"ru":"Товар DC"}','dc100000-0000-4000-8000-000000000002','active');
-- 1 piece = 1.0 kg gross / 0.9 kg net, 10 pieces per box, 1000 pieces per pallet.
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg,net_weight_kg) values
 ('dc200000-0000-4000-8000-000000000001','piece',1,1.0,0.9),
 ('dc200000-0000-4000-8000-000000000001','box',10,10,null),
 ('dc200000-0000-4000-8000-000000000001','pallet',1000,null,null);

set session_replication_role=replica;
insert into public.contracts(id,counterparty_id,number,type,valid_to,status) values
 ('dc110000-0000-4000-8000-000000000001','dc100000-0000-4000-8000-000000000001','K-1','sale',current_date+365,'active');
insert into public.shipments(id,shipment_number,type,customer_id,contract_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by,status,planned_arrival_date)
select s.id::uuid,s.num,'export','dc100000-0000-4000-8000-000000000001',s.contract::uuid,(select id from public.routes limit 1),(select id from public.process_templates limit 1),
 (select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),'dc000000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001',s.status,current_date+10
from (values ('dc300000-0000-4000-8000-000000000001','DC-1','dc110000-0000-4000-8000-000000000001','in_transit'),
             ('dc300000-0000-4000-8000-000000000002','DC-CLOSED',null,'closed')) s(id,num,contract,status);
insert into public.shipment_transports(id,shipment_id,sequence_no,status,vehicle_plate,trailer_plate,planned_arrival_date) values
 ('dc310000-0000-4000-8000-000000000001','dc300000-0000-4000-8000-000000000001',1,'in_transit','111AAA11','22BBB22',current_date+10),
 ('dc310000-0000-4000-8000-000000000002','dc300000-0000-4000-8000-000000000001',2,'in_transit','333CCC33','44DDD44',current_date+10);
insert into public.shipment_items(shipment_id,shipment_transport_id,product_id,uom,ordered_quantity) values
 ('dc300000-0000-4000-8000-000000000001','dc310000-0000-4000-8000-000000000001','dc200000-0000-4000-8000-000000000001','piece',1000),
 ('dc300000-0000-4000-8000-000000000001','dc310000-0000-4000-8000-000000000002','dc200000-0000-4000-8000-000000000001','box',200);

update public.shipment_transports set purchase_pallet_tare_kg=22,sale_pallet_tare_kg=22 where shipment_id='dc300000-0000-4000-8000-000000000001';

-- Documents: d1 order (vehicle 1), d2 CMR (vehicle 1), d3 invoice (whole shipment), d4 vehicle papers (not bound),
-- d5 unread scan, d6 certificate of vehicle 2 expiring before arrival, d7 expired certificate of the shipment.
insert into public.documents(id,document_type_id,title,document_number,valid_until,status,source,uploaded_by,current_version)
select d.id::uuid,t.id,d.title,d.num,d.valid_until,'approved','manual_upload','dc000000-0000-4000-8000-000000000001',1
from (values
 ('dc400000-0000-4000-8000-000000000001','transport_order','Договор-заявка',null,null::date),
 ('dc400000-0000-4000-8000-000000000002','cmr','CMR авто 1',null,null),
 ('dc400000-0000-4000-8000-000000000003','invoice','Инвойс','INV-2',null),
 ('dc400000-0000-4000-8000-000000000004','vehicle_document','Техпаспорт',null,null),
 ('dc400000-0000-4000-8000-000000000005','other','Скан',null,null),
 ('dc400000-0000-4000-8000-000000000006','certificate','Сертификат авто 2',null,current_date+5),
 ('dc400000-0000-4000-8000-000000000007','certificate','Старый сертификат',null,current_date-1)) d(id,code,title,num,valid_until)
join public.document_types t on t.code=d.code;
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select ('dc41000'||n||'-0000-4000-8000-000000000001')::uuid,('dc400000-0000-4000-8000-00000000000'||n)::uuid,1,
 'documents/dc400000-0000-4000-8000-00000000000'||n||'/0000000000000000000000000000000'||n||'-d.pdf','d.pdf','application/pdf',10,true,'dc000000-0000-4000-8000-000000000001'
from generate_series(1,7) n;
insert into public.document_links(document_id,entity_type,entity_id,created_by) values
 ('dc400000-0000-4000-8000-000000000001','shipment_transport','dc310000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001'),
 ('dc400000-0000-4000-8000-000000000002','shipment_transport','dc310000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001'),
 ('dc400000-0000-4000-8000-000000000003','shipment','dc300000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001'),
 ('dc400000-0000-4000-8000-000000000004','shipment','dc300000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001'),
 ('dc400000-0000-4000-8000-000000000005','shipment','dc300000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001'),
 ('dc400000-0000-4000-8000-000000000006','shipment_transport','dc310000-0000-4000-8000-000000000002','dc000000-0000-4000-8000-000000000001'),
 ('dc400000-0000-4000-8000-000000000007','shipment','dc300000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001');
insert into public.shipment_source_extractions(id,shipment_id,document_id,document_version_id,source_kind,status,extracted_data,confirmed_data,shipment_transport_id,extractor_version,requested_by,reviewed_by,reviewed_at)
values
 ('dc500000-0000-4000-8000-000000000001','dc300000-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000001','dc410001-0000-4000-8000-000000000001',
  'transport_order','confirmed','{}','{"vehicle_plate":"111 aaa-11","trailer_plate":"99ZZZ99"}','dc310000-0000-4000-8000-000000000001','rules-v1','dc000000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001',now()),
 ('dc500000-0000-4000-8000-000000000002','dc300000-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000002','dc410002-0000-4000-8000-000000000001',
  'waybill','extracted','{"gross_weight_kg":1040,"net_weight_kg":1000,"pallet_count":3}','{}','dc310000-0000-4000-8000-000000000001','rules-v1','dc000000-0000-4000-8000-000000000001',null,null),
 ('dc500000-0000-4000-8000-000000000003','dc300000-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000003','dc410003-0000-4000-8000-000000000001',
  'invoice','extracted','{"gross_weight_kg":"3 050,0","invoice_number":"INV-1","contract_number":"K-77"}','{}',null,'rules-v1','dc000000-0000-4000-8000-000000000001',null,null),
 ('dc500000-0000-4000-8000-000000000004','dc300000-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000004','dc410004-0000-4000-8000-000000000001',
  'vehicle_document','needs_review','{"vehicle_plate":"555XXX55","trailer_plate":"44 DDD 44"}','{}',null,'rules-v1','dc000000-0000-4000-8000-000000000001',null,null),
 ('dc500000-0000-4000-8000-000000000005','dc300000-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000005','dc410005-0000-4000-8000-000000000001',
  'other','failed','{}','{}',null,'rules-v1','dc000000-0000-4000-8000-000000000001',null,null);
-- Mandatory: a packing list for the shipment and a CMR for every vehicle.
insert into public.document_requirements(document_type_id,applies_to,shipment_type,is_mandatory)
select id,'shipment','export',true from public.document_types where code='packing_list'
union all
select id,'shipment_transport','export',true from public.document_types where code='cmr';
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
create function pg_temp.codes(p_findings jsonb) returns text language sql as $$
 select coalesce(string_agg(concat_ws(':',f->>'severity',f->>'code',coalesce(f->>'transport_no','-'),coalesce(f->>'field','-')),' | ' order by f->>'severity',f->>'code',f->>'transport_no',f->>'field'),'')
 from jsonb_array_elements(p_findings) f $$;
grant execute on function pg_temp.codes(jsonb) to authenticated;
create temp table dc_state as
 select (select max(updated_at) from public.shipments) s,(select max(updated_at) from public.shipment_transports) t,
        (select max(updated_at) from public.shipment_source_extractions) e,(select max(updated_at) from public.documents) d,
        (select count(*) from public.tasks) tasks;
grant select on dc_state to authenticated;

-- ---------- privileges ----------
do $$ begin
 assert has_function_privilege('authenticated','public.shipment_document_check(uuid)','execute');
 assert has_function_privilege('authenticated','public.run_shipment_document_check(uuid,text)','execute');
 assert not has_function_privilege('authenticated','public.run_document_checks(date)','execute'),'the daily run is not for employees';
 assert not has_function_privilege('anon','public.shipment_document_check(uuid)','execute');
 assert has_function_privilege('service_role','public.run_document_checks(date)','execute');
 assert not has_function_privilege('service_role','public.shipment_document_check(uuid)','execute'),'the server key reads no findings';
 assert not has_table_privilege('authenticated','public.shipment_document_checks','select'),'check state is internal';
 assert not has_function_privilege('authenticated','private.document_check_findings(uuid,date)','execute');
end $$;

-- ---------- findings ----------
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
do $$
declare v jsonb := public.shipment_document_check('dc300000-0000-4000-8000-000000000001');
begin
 assert pg_temp.codes(v->'findings') =
  'error:document_expired:-:valid_until | error:document_expires_before_arrival:-:valid_until | error:plate_mismatch:1:trailer_plate | error:plate_unknown:-:vehicle_plate | error:weight_mismatch:1:net_weight_kg'
  ||' | warning:contract_number_mismatch:-:contract_number | warning:document_missing:2:cmr | warning:document_missing:-:packing_list | warning:document_needs_review:-:- | warning:document_not_read:-:- | warning:invoice_number_mismatch:-:invoice_number | warning:pallet_mismatch:1:pallet_count',
  format('unexpected findings: %s', pg_temp.codes(v->'findings'));
 -- errors first; values are explained
 assert (v->'findings'->0->>'severity')='error';
 assert exists(select 1 from jsonb_array_elements(v->'findings') f where f->>'code'='weight_mismatch' and f->>'document_value'='1000 кг' and f->>'card_value'='900 кг ± 50 кг'),'weight message shows document, calculation and tolerance';
 assert exists(select 1 from jsonb_array_elements(v->'findings') f where f->>'code'='plate_mismatch' and f->>'card_value'='22BBB22' and f->>'document_id'='dc400000-0000-4000-8000-000000000001'),'the plate links to its document';
 assert exists(select 1 from jsonb_array_elements(v->'findings') f where f->>'code'='document_expires_before_arrival' and f->>'document_title'='Сертификат авто 2'),'the vehicle certificate expires before the vehicle arrives';
 -- matching values are not reported: plate 111 aaa-11, gross 1040 (tolerance 50), invoice gross 3 050,0 against 3000 (tolerance 60), trailer 44 DDD 44
 assert not exists(select 1 from jsonb_array_elements(v->'findings') f where f->>'field'='gross_weight_kg'),'weights within tolerance pass';
 assert not exists(select 1 from jsonb_array_elements(v->'findings') f where f->>'code'='plate_unknown' and f->>'field'='trailer_plate'),'a known trailer of another vehicle passes';
 assert v->'last_run_at' = 'null'::jsonb,'nothing has run yet';
 -- closed shipments are not checked
 assert public.shipment_document_check('dc300000-0000-4000-8000-000000000002')->'findings'='[]'::jsonb;
end $$;

-- the tolerance is the larger of 2 % and 50 kg
reset role;
do $$ begin
 assert private.document_check_weight_tolerance(1000)=50 and private.document_check_weight_tolerance(10000)=200;
 assert private.document_check_number('1 234,5')=1234.5 and private.document_check_number('abc') is null;
end $$;

-- missing documents become errors once customs starts
set session_replication_role=replica;
update public.shipments set status='customs' where id='dc300000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
do $$
declare v jsonb := public.shipment_document_check('dc300000-0000-4000-8000-000000000001');
begin
 assert (select count(*) from jsonb_array_elements(v->'findings') f where f->>'code'='document_missing' and f->>'severity'='error')=2,'missing documents are errors at customs';
 assert not exists(select 1 from jsonb_array_elements(v->'findings') f where f->>'message' like '%нужен до таможенного%'),'no "before customs" hint at customs';
end $$;
reset role;
set session_replication_role=replica;
update public.shipments set status='in_transit' where id='dc300000-0000-4000-8000-000000000001';
set session_replication_role=origin;

-- ---------- access ----------
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000004',false);
select pg_temp.fails($$select public.shipment_document_check('dc300000-0000-4000-8000-000000000001')$$,'Нет доступа');
select pg_temp.fails($$select public.run_shipment_document_check('dc300000-0000-4000-8000-000000000001')$$,'Нет доступа');
select pg_temp.fails($$select public.run_document_checks()$$,'permission denied');
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$select public.run_shipment_document_check('dc300000-0000-4000-8000-000000000001','daily')$$,'Недопустимый источник');
select pg_temp.fails($$select public.shipment_document_check('dc3fffff-0000-4000-8000-000000000001')$$,'не найдена');

-- ---------- notifications: to administrator, director and logistics, once per problem ----------
do $$
declare v jsonb;
begin
 v := public.run_shipment_document_check('dc300000-0000-4000-8000-000000000001');
 assert jsonb_array_length(v)=12,'the run returns the findings';
 assert (select count(*) from public.notifications where shipment_id='dc300000-0000-4000-8000-000000000001')=1,'the director sees one notification';
 assert (select type||'|'||entity_type||'|'||entity_id from public.notifications where shipment_id='dc300000-0000-4000-8000-000000000001')
   ='discrepancy|shipment_document_check|dc300000-0000-4000-8000-000000000001';
 assert (select title from public.notifications where shipment_id='dc300000-0000-4000-8000-000000000001')='Сверка DC-1: найдены ошибки';
 assert (select body from public.notifications where shipment_id='dc300000-0000-4000-8000-000000000001') like 'Ошибок: 5, предупреждений: 7. Новое: %';
 assert (select body from public.notifications where shipment_id='dc300000-0000-4000-8000-000000000001') not like '%99ZZZ99%','no plates or values in the text';
 -- the second run finds nothing new
 perform public.run_shipment_document_check('dc300000-0000-4000-8000-000000000001');
 assert (select count(*) from public.notifications where shipment_id='dc300000-0000-4000-8000-000000000001')=1,'no repeated notification';
 assert (public.shipment_document_check('dc300000-0000-4000-8000-000000000001')->>'last_run_source')='recognition';
end $$;
reset role;
-- Employees committed by other test files may also hold these roles; only this file's users are counted.
create temp view dc_notes as select n.* from public.notifications n
 where n.shipment_id='dc300000-0000-4000-8000-000000000001' and n.recipient_user_id::text like 'dc000000-%';
do $$ begin
 assert (select count(*) from dc_notes)=3,'administrator, director and logistics specialist';
 assert not exists(select 1 from public.notifications n where n.shipment_id='dc300000-0000-4000-8000-000000000001'
   and not exists(select 1 from public.user_roles ur join public.app_roles r on r.id=ur.role_id
                  where ur.user_id=n.recipient_user_id and r.code=any(private.document_check_recipient_roles()))),'only recipient roles are notified';
 assert (select string_agg(recipient_user_id::text,',' order by recipient_user_id) from dc_notes)
   ='dc000000-0000-4000-8000-000000000001,dc000000-0000-4000-8000-000000000002,dc000000-0000-4000-8000-000000000005',
   'not the accountant (other role) nor the logistics manager without documents.view';
 assert (select status||'|'||error_count||'|'||warning_count from public.shipment_document_checks where shipment_id='dc300000-0000-4000-8000-000000000001')='error|5|7';
end $$;

-- the agent changed nothing in the shipment, vehicles, documents or extractions, and created no tasks
do $$ begin
 assert (select max(updated_at) from public.shipments) is not distinct from (select s from dc_state);
 assert (select max(updated_at) from public.shipment_transports) is not distinct from (select t from dc_state);
 assert (select max(updated_at) from public.shipment_source_extractions) is not distinct from (select e from dc_state);
 assert (select max(updated_at) from public.documents) is not distinct from (select d from dc_state);
 assert (select count(*) from public.tasks)=(select tasks from dc_state);
end $$;

-- ---------- daily run: a fixed problem is forgotten, a new one is reported again ----------
set session_replication_role=replica;
update public.shipment_transports set trailer_plate='99ZZZ99' where id='dc310000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role service_role;
do $$ begin
 assert public.run_document_checks()=1,'only the active shipment is checked';
end $$;
reset role;
do $$ begin
 assert (select count(*) from dc_notes)=3,'a fixed problem sends nothing';
 assert (select source||'|'||error_count from public.shipment_document_checks where shipment_id='dc300000-0000-4000-8000-000000000001')='daily|4';
end $$;
set session_replication_role=replica;
update public.shipment_transports set trailer_plate='22BBB22' where id='dc310000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role service_role;
select public.run_document_checks();
reset role;
do $$ begin
 assert (select count(*) from dc_notes)=6,'the problem came back: reported again to each recipient';
 assert (select count(*) from dc_notes where body like '%Госномер прицепа%')=3;
end $$;

-- a document dropped from the shipment is no longer checked
set session_replication_role=replica;
update public.documents set archived_at=now(),archived_by='dc000000-0000-4000-8000-000000000001',archive_reason='test' where id='dc400000-0000-4000-8000-000000000007';
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
do $$ begin
 assert not exists(select 1 from jsonb_array_elements(public.shipment_document_check('dc300000-0000-4000-8000-000000000001')->'findings') f where f->>'code'='document_expired');
end $$;

-- ========== Review fixes: opaque keys for hidden documents, linked documents, current versions ==========
-- A director who may not open generated documents with prices.
reset role;
insert into auth.users(id,email,raw_user_meta_data) values
 ('dc000000-0000-4000-8000-000000000006','dc-noprices@test.local','{"full_name":"DC No prices"}');
insert into public.user_roles(user_id,role_id) select 'dc000000-0000-4000-8000-000000000006',id from public.app_roles where code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'dc000000-0000-4000-8000-000000000006',p.id,'deny','document check test','dc000000-0000-4000-8000-000000000001'
from public.permissions p where p.code='templates.generate_prices';
-- d8: a generated invoice with prices, linked to the shipment, with numbers that do not match.
set session_replication_role=replica;
insert into public.documents(id,document_type_id,title,document_number,status,source,uploaded_by,current_version)
select 'dc400000-0000-4000-8000-000000000008',id,'Секретный инвойс','INV-SECRET-9','approved','generated','dc000000-0000-4000-8000-000000000001',1
from public.document_types where code='invoice';
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
values('dc410008-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000008',1,
 'documents/dc400000-0000-4000-8000-000000000008/00000000000000000000000000000008-d.pdf','d.pdf','application/pdf',10,true,'dc000000-0000-4000-8000-000000000001');
insert into public.document_generations(template_id,template_version_id,shipment_id,document_id,output_format,contains_prices,fields_snapshot,generated_by)
values(gen_random_uuid(),gen_random_uuid(),'dc300000-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000008','docx',true,'{}','dc000000-0000-4000-8000-000000000001');
insert into public.document_links(document_id,entity_type,entity_id,created_by) values
 ('dc400000-0000-4000-8000-000000000008','shipment','dc300000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001');
insert into public.shipment_source_extractions(id,shipment_id,document_id,document_version_id,source_kind,status,extracted_data,extractor_version,requested_by)
values('dc500000-0000-4000-8000-000000000008','dc300000-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000008','dc410008-0000-4000-8000-000000000001',
 'invoice','extracted','{"invoice_number":"INV-SECRET-1","contract_number":"K-SECRET-5"}','rules-v1','dc000000-0000-4000-8000-000000000001');
set session_replication_role=origin;

create temp table dc_keys(source text,keys text[]);
grant select,insert on dc_keys to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000006',false);
do $$
declare
 v_read jsonb := public.shipment_document_check('dc300000-0000-4000-8000-000000000001');
 v_run jsonb := public.run_shipment_document_check('dc300000-0000-4000-8000-000000000001','manual');
 v_text text;
begin
 foreach v_text in array array[v_read::text, v_run::text] loop
  assert v_text !~* 'dc400000-0000-4000-8000-000000000008|dc410008|Секретный инвойс|INV-?SECRET|K-?SECRET|INVSECRET|KSECRET',
   format('hidden document details leak: %s', v_text);
 end loop;
 -- the hidden document still counts, without its details
 assert exists(select 1 from jsonb_array_elements(v_read->'findings') f where f->>'code'='invoice_number_mismatch' and not f ? 'document_id'),'the hidden mismatch is reported without details';
 -- allowed findings keep their details and links
 assert exists(select 1 from jsonb_array_elements(v_read->'findings') f where f->>'code'='plate_mismatch' and f->>'document_id'='dc400000-0000-4000-8000-000000000001' and f->>'card_value'='22BBB22');
 -- keys are opaque and stable: the same finding has the same key in both functions and in a repeated call
 assert (select bool_and(f->>'key' ~ '^[0-9a-f]{32}$') from jsonb_array_elements(v_read->'findings') f),'keys are opaque';
 insert into dc_keys select 'read',array(select f->>'key' from jsonb_array_elements(v_read->'findings') f order by 1);
 insert into dc_keys select 'run',array(select f->>'key' from jsonb_array_elements(v_run) f order by 1);
 insert into dc_keys select 'again',array(select f->>'key' from jsonb_array_elements(public.shipment_document_check('dc300000-0000-4000-8000-000000000001')->'findings') f order by 1);
 assert (select count(distinct keys) from dc_keys)=1,'the same keys in both functions and on every call';
end $$;
-- the employee who may open the document sees it, under the same opaque key
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
do $$
declare v jsonb := public.shipment_document_check('dc300000-0000-4000-8000-000000000001');
begin
 assert exists(select 1 from jsonb_array_elements(v->'findings') f where f->>'code'='invoice_number_mismatch' and f->>'document_id'='dc400000-0000-4000-8000-000000000008');
 assert array(select f->>'key' from jsonb_array_elements(v->'findings') f order by 1)=(select keys from dc_keys where source='read'),'keys do not depend on who asks';
 assert v::text !~ 'INVSECRET|KSECRET','normalised values never appear in keys';
end $$;

-- ---------- only documents still linked to the shipment or its vehicles ----------
reset role;
set session_replication_role=replica;
-- d4 (vehicle papers, unknown plate) is unlinked; d2 (CMR of vehicle 1) gets a second link to the shipment, then loses the vehicle link.
update public.document_links set removed_at=now(),removed_by='dc000000-0000-4000-8000-000000000001' where document_id='dc400000-0000-4000-8000-000000000004';
insert into public.document_links(document_id,entity_type,entity_id,created_by) values
 ('dc400000-0000-4000-8000-000000000002','shipment','dc300000-0000-4000-8000-000000000001','dc000000-0000-4000-8000-000000000001');
update public.document_links set removed_at=now(),removed_by='dc000000-0000-4000-8000-000000000001'
 where document_id='dc400000-0000-4000-8000-000000000002' and entity_type='shipment_transport';
set session_replication_role=origin;
set role authenticated;
do $$
declare v jsonb := public.shipment_document_check('dc300000-0000-4000-8000-000000000001')->'findings';
begin
 assert not exists(select 1 from jsonb_array_elements(v) f where f->>'document_id'='dc400000-0000-4000-8000-000000000004'),'an unlinked document is no longer checked';
 assert not exists(select 1 from jsonb_array_elements(v) f where f->>'code'='plate_unknown'),'its plate is not reported';
 assert exists(select 1 from jsonb_array_elements(v) f where f->>'code'='weight_mismatch' and f->>'document_id'='dc400000-0000-4000-8000-000000000002'),'a document with another active link is still checked';
end $$;

-- ---------- only the current version of a document ----------
reset role;
set session_replication_role=replica;
-- d3 (invoice with mismatching numbers) gets a new current version that is not recognised yet.
update public.documents set current_version=2 where id='dc400000-0000-4000-8000-000000000003';
update public.document_versions set is_current=false where document_id='dc400000-0000-4000-8000-000000000003';
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
values('dc410003-0000-4000-8000-000000000002','dc400000-0000-4000-8000-000000000003',2,
 'documents/dc400000-0000-4000-8000-000000000003/00000000000000000000000000000032-d.pdf','d.pdf','application/pdf',10,true,'dc000000-0000-4000-8000-000000000001');
set session_replication_role=origin;
set role authenticated;
do $$
declare v jsonb := public.shipment_document_check('dc300000-0000-4000-8000-000000000001')->'findings';
begin
 assert not exists(select 1 from jsonb_array_elements(v) f where f->>'document_id'='dc400000-0000-4000-8000-000000000003' and f->>'code' in ('invoice_number_mismatch','contract_number_mismatch')),
  'values of the previous version are not presented as the new version';
 assert exists(select 1 from jsonb_array_elements(v) f where f->>'code'='document_version_not_read' and f->>'document_id'='dc400000-0000-4000-8000-000000000003' and f->>'severity'='warning'),
  'the unread new version is reported, not passed as matching';
end $$;
reset role;
-- the new version is recognised: its own values are checked
set session_replication_role=replica;
insert into public.shipment_source_extractions(id,shipment_id,document_id,document_version_id,source_kind,status,extracted_data,extractor_version,requested_by)
values('dc500000-0000-4000-8000-000000000033','dc300000-0000-4000-8000-000000000001','dc400000-0000-4000-8000-000000000003','dc410003-0000-4000-8000-000000000002',
 'invoice','extracted','{"invoice_number":"INV-2","contract_number":"K-1","gross_weight_kg":9000}','rules-v1','dc000000-0000-4000-8000-000000000001');
set session_replication_role=origin;
set role authenticated;
do $$
declare v jsonb := public.shipment_document_check('dc300000-0000-4000-8000-000000000001')->'findings';
begin
 assert not exists(select 1 from jsonb_array_elements(v) f where f->>'document_id'='dc400000-0000-4000-8000-000000000003' and f->>'code' in ('document_version_not_read','invoice_number_mismatch','contract_number_mismatch'));
 assert exists(select 1 from jsonb_array_elements(v) f where f->>'document_id'='dc400000-0000-4000-8000-000000000003' and f->>'code'='weight_mismatch' and f->>'document_value'='9000 кг'),
  'the new version is checked with its own values';
end $$;

reset role;
rollback;
\echo 'document_check_agent: all checks passed'
