-- Several vehicles in one shipment (202609275100): per-vehicle data, add/update/remove rules and permissions,
-- source documents and OCR proposals bound to one vehicle, review writes to that vehicle only,
-- cargo stays bound by the user (no automatic distribution), single-vehicle shipments keep working.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ea000000-0000-4000-8000-000000000001','mv-director@test.local','{"full_name":"MV Director"}'),
 ('ea000000-0000-4000-8000-000000000002','mv-readonly@test.local','{"full_name":"MV Read only"}'),
 ('ea000000-0000-4000-8000-000000000003','mv-noview@test.local','{"full_name":"MV No view"}'),
 ('ea000000-0000-4000-8000-000000000004','mv-noextract@test.local','{"full_name":"MV No extract"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('ea000000-0000-4000-8000-000000000001'),('ea000000-0000-4000-8000-000000000002'),('ea000000-0000-4000-8000-000000000003'),('ea000000-0000-4000-8000-000000000004')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select x.u::uuid,p.id,'deny','multi-vehicle test','ea000000-0000-4000-8000-000000000001' from (values
 ('ea000000-0000-4000-8000-000000000002','shipments.update'),
 ('ea000000-0000-4000-8000-000000000003','shipments.view'),
 ('ea000000-0000-4000-8000-000000000004','source_documents.extract')) x(u,code) join public.permissions p on p.code=x.code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ea100000-0000-4000-8000-000000000001',array['customer'],'MV customer','KZ','MV-A'),
 ('ea100000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'MV supplier','FI','MV-B');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ea200000-0000-4000-8000-000000000001','MV-001','{"ru":"Товар MV"}','ea100000-0000-4000-8000-000000000002','active');

set session_replication_role=replica;
insert into public.shipments(id,shipment_number,type,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select s.id::uuid,s.num,'export','ea100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates limit 1),
 (select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),'ea000000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-000000000001'
from (values ('ea300000-0000-4000-8000-000000000001','MV-1'),('ea300000-0000-4000-8000-000000000002','MV-2'),('ea300000-0000-4000-8000-000000000003','MV-SINGLE')) s(id,num);
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity) values
 ('ea400000-0000-4000-8000-000000000001','ea300000-0000-4000-8000-000000000001','ea200000-0000-4000-8000-000000000001','piece',1000);
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
create temp table mv_ids(name text primary key,id uuid);
grant select,insert,update on mv_ids to authenticated;

-- ---------- permissions ----------
set role authenticated;
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000002',false);
select pg_temp.fails($$select public.add_shipment_transport('ea300000-0000-4000-8000-000000000001')$$,'Недостаточно прав');
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000003',false);
select pg_temp.fails($$select public.add_shipment_transport('ea300000-0000-4000-8000-000000000001')$$,'Недостаточно прав');
select pg_temp.fails($$select public.create_shipment_transport('ea300000-0000-4000-8000-000000000001',null,null,null,null,'X')$$,'Недостаточно прав');
do $$ begin assert (select count(*) from public.shipment_transports)=0,'nothing was created by denied users'; end $$;
-- the table cannot be written directly, only through the RPCs
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$update public.shipment_transports set driver_name='x'$$,'permission denied');
select pg_temp.fails($$insert into public.shipment_transports(shipment_id,sequence_no) values('ea300000-0000-4000-8000-000000000001',9)$$,'permission denied');

-- ---------- add: each vehicle has its own data ----------
do $$ declare v integer; begin
 v:=public.create_shipment_transport('ea300000-0000-4000-8000-000000000001',current_date,current_date+10,'+2…+6','first','Иванов И.И.','+7 700 000 0001','уд. 111','111AAA11','SCANIA','22BBB22','SCHMITZ','ТОО Перевозчик А');
 assert v=1,'first vehicle is number 1';
 assert public.create_shipment_transport('ea300000-0000-4000-8000-000000000001',null,null,null,null,'Петров П.П.','+7 700 000 0002',null,'222CCC22','VOLVO','33DDD33','KRONE','ТОО Перевозчик Б')=2,'second vehicle is number 2';
 assert public.create_shipment_transport('ea300000-0000-4000-8000-000000000001')=3,'a vehicle may be added empty and filled in later';
 insert into mv_ids select 't'||sequence_no,id from public.shipment_transports where shipment_id='ea300000-0000-4000-8000-000000000001';
 assert (select driver_name||'|'||driver_phone||'|'||driver_document||'|'||vehicle_plate||'|'||vehicle_make||'|'||trailer_plate||'|'||trailer_make||'|'||carrier_name from public.shipment_transports where id=(select id from mv_ids where name='t1'))
  ='Иванов И.И.|+7 700 000 0001|уд. 111|111AAA11|SCANIA|22BBB22|SCHMITZ|ТОО Перевозчик А','vehicle 1 keeps all of its own data';
 assert (select driver_name||'|'||vehicle_plate||'|'||trailer_make from public.shipment_transports where id=(select id from mv_ids where name='t2'))='Петров П.П.|222CCC22|KRONE','vehicle 2 has different data';
 assert (select count(*) from public.shipment_stage_runs where shipment_transport_id=(select id from mv_ids where name='t1'))
      =(select count(*) from public.shipment_stage_runs where shipment_transport_id=(select id from mv_ids where name='t2')),'every vehicle gets its own full set of transport stages';
 assert (select count(*) from public.shipment_stage_runs where shipment_transport_id=(select id from mv_ids where name='t1'))>0,'transport stages exist';
 -- cargo is never distributed on its own
 assert (select count(*) from public.shipment_items where shipment_id='ea300000-0000-4000-8000-000000000001' and shipment_transport_id is null)=1,'the item stays unallocated until the user allocates it';
end $$;

-- ---------- validation ----------
select pg_temp.fails($$select public.create_shipment_transport('ea300000-0000-4000-8000-000000000001',null,null,null,null,null,null,null,'111 aaa-11')$$,'уже есть в этой поставке');
select pg_temp.fails($$select public.create_shipment_transport('ea300000-0000-4000-8000-000000000001',null,null,null,null,null,null,null,repeat('X',41))$$,'длиннее');
select pg_temp.fails($$select public.create_shipment_transport('ea300000-0000-4000-8000-000000000001',current_date+5,current_date)$$,'раньше плановой загрузки');
select pg_temp.fails($$select public.update_shipment_transport((select id from mv_ids where name='t3'),'{"status":"arrived"}')$$,'Недопустимое поле');
select pg_temp.fails($$select public.update_shipment_transport((select id from mv_ids where name='t3'),'{}')$$,'Укажите, что изменить');
select pg_temp.fails($$select public.update_shipment_transport((select id from mv_ids where name='t3'),'{"vehicle_plate":"111-AAA-11"}')$$,'уже есть в этой поставке');
select pg_temp.fails($$select public.update_shipment_transport((select id from mv_ids where name='t3'),'{"driver_name":5}')$$,'Некорректное значение');

-- ---------- update ----------
do $$ begin
 perform public.update_shipment_transport((select id from mv_ids where name='t3'),'{"driver_name":"Сидоров С.С.","vehicle_plate":"333EEE33","vehicle_make":"MAN","trailer_plate":"44FFF44","trailer_make":"WIELTON","carrier_name":"ТОО Перевозчик В","driver_phone":"+7 700 000 0003"}');
 assert (select vehicle_plate||'|'||trailer_make||'|'||driver_phone from public.shipment_transports where id=(select id from mv_ids where name='t3'))='333EEE33|WIELTON|+7 700 000 0003','vehicle 3 filled in later';
 perform public.update_shipment_transport((select id from mv_ids where name='t3'),'{"driver_phone":""}');
 assert (select driver_phone is null and driver_name='Сидоров С.С.' from public.shipment_transports where id=(select id from mv_ids where name='t3')),'an empty string clears one field and leaves the rest';
 assert (select driver_name from public.shipment_transports where id=(select id from mv_ids where name='t1'))='Иванов И.И.','other vehicles are untouched by an update';
end $$;

-- ---------- cargo bound to a vehicle by the user ----------
do $$ begin
 perform public.allocate_shipment_item('ea400000-0000-4000-8000-000000000001',(select id from mv_ids where name='t2'),400);
 assert (select sum(ordered_quantity) from public.shipment_items where shipment_id='ea300000-0000-4000-8000-000000000001')=1000,'allocation splits and never changes the total';
 assert (select ordered_quantity from public.shipment_items where shipment_transport_id=(select id from mv_ids where name='t2'))=400,'400 pieces are bound to vehicle 2';
end $$;
select pg_temp.fails($$select public.remove_shipment_transport((select id from mv_ids where name='t2'))$$,'привязаны товары');
do $$ begin
 perform public.allocate_shipment_item((select id from public.shipment_items where shipment_transport_id=(select id from mv_ids where name='t2')),null,400);
 assert (select count(*) from public.shipment_items where shipment_id='ea300000-0000-4000-8000-000000000001')=1,'returned quantity merges back into one unallocated row';
end $$;

-- ---------- documents and OCR proposals belong to a vehicle ----------
reset role;
set session_replication_role=replica;
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select d.id::uuid,t.id,'Doc '||d.n,'approved','manual_upload','ea000000-0000-4000-8000-000000000001',1
from (values ('ea500000-0000-4000-8000-000000000001','1'),('ea500000-0000-4000-8000-000000000002','2'),('ea500000-0000-4000-8000-000000000003','3'),('ea500000-0000-4000-8000-000000000004','4'),('ea500000-0000-4000-8000-000000000005','5')) d(id,n)
cross join (select id from public.document_types where code='driver_document') t;
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select ('ea51000'||n||'-0000-4000-8000-000000000001')::uuid,('ea50000'||'0-0000-4000-8000-00000000000'||n)::uuid,1,
 'documents/ea500000-0000-4000-8000-00000000000'||n||'/00000000000000000000000000000001-d'||n||'.pdf','d'||n||'.pdf','application/pdf',10,true,'ea000000-0000-4000-8000-000000000001'
from generate_series(1,5) n;
insert into public.document_links(document_id,entity_type,entity_id,created_by) values
 ('ea500000-0000-4000-8000-000000000001','shipment','ea300000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-000000000001'),
 ('ea500000-0000-4000-8000-000000000002','shipment_transport',(select id from mv_ids where name='t2'),'ea000000-0000-4000-8000-000000000001'),
 ('ea500000-0000-4000-8000-000000000003','shipment_transport',(select id from mv_ids where name='t1'),'ea000000-0000-4000-8000-000000000001'),
 ('ea500000-0000-4000-8000-000000000003','shipment_transport',(select id from mv_ids where name='t2'),'ea000000-0000-4000-8000-000000000001'),
 ('ea500000-0000-4000-8000-000000000004','shipment','ea300000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-000000000001'),
 ('ea500000-0000-4000-8000-000000000005','shipment','ea300000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-000000000001');
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000001',false);
do $$ declare i integer; begin
 for i in 1..5 loop
  perform public.upsert_shipment_source_extraction('ea300000-0000-4000-8000-000000000001',('ea500000-0000-4000-8000-00000000000'||i)::uuid,('ea51000'||i||'-0000-4000-8000-000000000001')::uuid,'driver_document','extracted',
   case i when 2 then '{"driver_name":"Driver Two","vehicle_plate":"222CCC22X","driver_phone":"+7 700 111 2222"}'
          when 4 then '{"driver_name":"Unassigned Driver","vehicle_plate":"999ZZZ99"}'
          when 5 then '{"contract_number":"MV-CONTRACT"}'
          else '{"driver_name":"Someone"}' end::jsonb);
 end loop;
 assert (select shipment_transport_id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000002')=(select id from mv_ids where name='t2'),'a document uploaded for vehicle 2 is bound to vehicle 2';
 assert (select shipment_transport_id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000001') is null,'a shipment-level document stays unbound';
 assert (select shipment_transport_id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000003') is null,'a document linked to two vehicles is ambiguous and stays unbound';
end $$;

-- binding by an employee
reset role;
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000004',false);
set role authenticated;
select pg_temp.fails($$select public.assign_source_extraction_transport((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004'),(select id from mv_ids where name='t1'))$$,'Нет права');
reset role;
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000003',false);
set role authenticated;
select pg_temp.fails($$select public.assign_source_extraction_transport((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004'),(select id from mv_ids where name='t1'))$$,'Нет доступа');
reset role;
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000001',false);
set role authenticated;
-- a vehicle of another shipment is refused
reset role;
set session_replication_role=replica;
insert into public.shipment_transports(id,shipment_id,sequence_no,vehicle_plate) values('ea600000-0000-4000-8000-000000000001','ea300000-0000-4000-8000-000000000002',1,'OTHER-1');
set session_replication_role=origin;
set role authenticated;
select pg_temp.fails($$select public.assign_source_extraction_transport((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004'),'ea600000-0000-4000-8000-000000000001','Synthetic cross-shipment context')$$,'не относится к этой поставке');
do $$ begin
 perform public.assign_source_extraction_transport((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004'),(select id from mv_ids where name='t1'),'Synthetic employee assignment');
 assert (select shipment_transport_id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004')=(select id from mv_ids where name='t1'),'assigned by the employee';
 perform public.assign_source_extraction_transport((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004'),null,'Synthetic shipment-wide context');
 assert (select shipment_transport_id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004') is null,'binding can be cleared';
end $$;

-- ---------- review writes to the vehicle of the document only ----------
do $$ begin
 perform public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000002'),null,true);
 assert (select driver_name||'|'||vehicle_plate||'|'||driver_phone from public.shipment_transports where id=(select id from mv_ids where name='t2'))='Driver Two|222CCC22X|+7 700 111 2222','vehicle 2 received the data of its document';
 assert (select driver_name||'|'||vehicle_plate from public.shipment_transports where id=(select id from mv_ids where name='t1'))='Иванов И.И.|111AAA11','vehicle 1 is untouched';
 assert (select driver_name||'|'||vehicle_plate from public.shipment_transports where id=(select id from mv_ids where name='t3'))='Сидоров С.С.|333EEE33','vehicle 3 is untouched';
end $$;
-- several vehicles and no binding: refuse to guess when the data is meant for a vehicle
select pg_temp.fails($$select public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004'),null,true)$$,'несколько автомобилей');
do $$ begin
 perform public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004'),null,false);
 assert (select status from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000004')='confirmed','without applying to the shipment the confirmation is stored';
 assert (select count(*) from public.shipment_transports where shipment_id='ea300000-0000-4000-8000-000000000001' and driver_name='Unassigned Driver')=0,'and no vehicle changed';
 -- shipment-level facts never need a vehicle
 perform public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000005'),null,true);
 assert (select status from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000005')='confirmed','a contract number is confirmed without choosing a vehicle';
end $$;
-- the same plate on two vehicles is refused: bind the third document to vehicle 1, then try vehicle 2's plate
do $$ begin
 perform public.assign_source_extraction_transport((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000003'),(select id from mv_ids where name='t1'),'Synthetic explicit vehicle context');
end $$;
select pg_temp.fails($$select public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000003'),'{"vehicle_plate":"222 ccc 22x"}'::jsonb,true)$$,'уже указан у другого автомобиля');
-- a confirmed proposal keeps its vehicle
select pg_temp.fails($$select public.assign_source_extraction_transport((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000002'),(select id from mv_ids where name='t1'),'Synthetic confirmed-source rejection')$$,'нельзя перепривязать');

-- ---------- removing vehicles ----------
do $$ begin
 perform public.remove_shipment_transport((select id from mv_ids where name='t3'));
 assert (select count(*) from public.shipment_transports where shipment_id='ea300000-0000-4000-8000-000000000001')=2,'the unused vehicle is gone';
 assert (select count(*) from public.shipment_stage_runs where shipment_transport_id=(select id from mv_ids where name='t3'))=0,'with its untouched stage runs';
end $$;
reset role;
-- a vehicle on its way, or one with started stages, can only be cancelled
update public.shipment_transports set status='in_transit' where id=(select id from mv_ids where name='t1');
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000001',false);
set role authenticated;
select pg_temp.fails($$select public.remove_shipment_transport((select id from mv_ids where name='t1'))$$,'отмените его');
reset role;
update public.shipment_transports set status='planned' where id=(select id from mv_ids where name='t1');
set session_replication_role=replica;
update public.shipment_stage_runs set status='in_progress' where id=(select id from public.shipment_stage_runs where shipment_transport_id=(select id from mv_ids where name='t1') order by created_at limit 1);
set session_replication_role=origin;
set role authenticated;
select pg_temp.fails($$select public.remove_shipment_transport((select id from mv_ids where name='t1'))$$,'уже выполнялись этапы');
-- documents of a removed vehicle stay with the shipment, their proposals become unbound
reset role;
update public.shipment_stage_runs set status='pending' where shipment_transport_id=(select id from mv_ids where name='t2');
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000001',false);
set role authenticated;
do $$ begin
 perform public.remove_shipment_transport((select id from mv_ids where name='t2'));
 assert (select count(*) from public.document_links where document_id='ea500000-0000-4000-8000-000000000002' and entity_type='shipment' and removed_at is null)=1,'the document is linked to the shipment instead of a removed vehicle';
 assert (select count(*) from public.document_links where entity_type='shipment_transport' and entity_id=(select id from mv_ids where name='t2') and removed_at is null)=0,'no live link points at the removed vehicle';
 assert (select shipment_transport_id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000002') is null,'the confirmed proposal no longer points at a vehicle';
end $$;

-- ---------- a closed shipment cannot be changed ----------
reset role;
set session_replication_role=replica;
update public.shipments set status='closed' where id='ea300000-0000-4000-8000-000000000001';
set session_replication_role=origin;
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000001',false);
set role authenticated;
select pg_temp.fails($$select public.create_shipment_transport('ea300000-0000-4000-8000-000000000001')$$,'недоступна для изменений');
select pg_temp.fails($$select public.update_shipment_transport((select id from mv_ids where name='t1'),'{"driver_name":"x"}')$$,'недоступна для изменений');
select pg_temp.fails($$select public.remove_shipment_transport((select id from mv_ids where name='t1'))$$,'недоступна для изменений');
reset role;
set session_replication_role=replica;
update public.shipments set status='planning' where id='ea300000-0000-4000-8000-000000000001';
set session_replication_role=origin;

-- ---------- a shipment with one vehicle keeps working without any assignment ----------
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000001',false);
set role authenticated;
do $$ begin
 assert public.create_shipment_transport('ea300000-0000-4000-8000-000000000003')=1;
end $$;
reset role;
set session_replication_role=replica;
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select 'ea500000-0000-4000-8000-000000000009',id,'Single','approved','manual_upload','ea000000-0000-4000-8000-000000000001',1 from public.document_types where code='driver_document';
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
values('ea510009-0000-4000-8000-000000000001','ea500000-0000-4000-8000-000000000009',1,'documents/ea500000-0000-4000-8000-000000000009/00000000000000000000000000000001-s.pdf','s.pdf','application/pdf',10,true,'ea000000-0000-4000-8000-000000000001');
insert into public.document_links(document_id,entity_type,entity_id,created_by) values('ea500000-0000-4000-8000-000000000009','shipment','ea300000-0000-4000-8000-000000000003','ea000000-0000-4000-8000-000000000001');
set session_replication_role=origin;
set role authenticated;
do $$ begin
 perform public.upsert_shipment_source_extraction('ea300000-0000-4000-8000-000000000003','ea500000-0000-4000-8000-000000000009','ea510009-0000-4000-8000-000000000001','driver_document','extracted','{"driver_name":"Single Driver","vehicle_plate":"SOLO-1","vehicle_make":"DAF"}');
 perform public.review_shipment_source_extraction((select id from public.shipment_source_extractions where document_id='ea500000-0000-4000-8000-000000000009'),null,true);
 assert (select driver_name||'|'||vehicle_plate||'|'||vehicle_make from public.shipment_transports where shipment_id='ea300000-0000-4000-8000-000000000003')='Single Driver|SOLO-1|DAF','the only vehicle receives the data without choosing it';
end $$;

-- ---------- grants ----------
do $$ begin
 assert not has_function_privilege('anon','public.update_shipment_transport(uuid,jsonb)','execute'),'anonymous cannot edit vehicles';
 assert not has_function_privilege('anon','public.remove_shipment_transport(uuid)','execute'),'anonymous cannot remove vehicles';
 assert not has_function_privilege('service_role','public.assign_source_extraction_transport(uuid,uuid)','execute'),'the service role cannot bypass the permission checks';
 assert has_function_privilege('authenticated','public.create_shipment_transport(uuid,date,date,text,text,text,text,text,text,text,text,text,text)','execute');
 assert has_function_privilege('authenticated','public.add_shipment_transport(uuid,date,date,text,text)','execute'),'the earlier entry point still exists';
end $$;

reset role;
rollback;
\echo 'multi_vehicle_shipments: all checks passed'
