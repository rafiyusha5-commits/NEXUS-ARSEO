-- «Логист» (202609277400): proposals are made from the shipment state, accepted with the employee's own rights,
-- rejected for good, made obsolete when the situation passes, and never visible or decidable without access.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ed000000-0000-4000-8000-000000000001','logist-director@test.local','{"full_name":"Logist Director"}'),
 ('ed000000-0000-4000-8000-000000000002','logist-limited@test.local','{"full_name":"Logist Limited"}'),
 ('ed000000-0000-4000-8000-000000000003','logist-nodocs@test.local','{"full_name":"Logist No Documents"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('ed000000-0000-4000-8000-000000000001'),('ed000000-0000-4000-8000-000000000002'),('ed000000-0000-4000-8000-000000000003')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select x.u::uuid,p.id,'deny','logist test','ed000000-0000-4000-8000-000000000001' from (values
 ('ed000000-0000-4000-8000-000000000002','shipments.change_status'),
 ('ed000000-0000-4000-8000-000000000002','tasks.manage'),
 ('ed000000-0000-4000-8000-000000000003','documents.view')) x(u,code) join public.permissions p on p.code=x.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('ed100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Logist supplier','FI','LOGIST-FI');

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create temporary table lg(name text primary key,id uuid);
grant select,insert,update on lg to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from lg where name=p_name $$;
grant execute on function pg_temp.id(text) to authenticated;
create function pg_temp.proposal(p_kind text,p_like text) returns uuid language sql as $$
 select id from public.logist_proposals where shipment_id=pg_temp.id('shipment') and kind=p_kind and title like p_like order by (status='pending') desc, created_at desc limit 1
$$;
grant execute on function pg_temp.proposal(text,text) to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);
insert into lg select 'shipment',public.create_shipment_with_stages('LOGIST-1','import','ed100000-0000-4000-8000-000000000001',null,
 (select id from public.routes limit 1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),
 'ed000000-0000-4000-8000-000000000001');
-- Three vehicles: two with plates, one still empty. Vehicles 1 and 2 were due three and two days ago.
select public.create_shipment_transport(pg_temp.id('shipment'),current_date-10,current_date-3,null,null,null,null,null,'111AAA11');
select public.create_shipment_transport(pg_temp.id('shipment'),current_date-10,current_date-2,null,null,null,null,null,'222BBB22');
select public.create_shipment_transport(pg_temp.id('shipment'));
insert into lg select 't'||sequence_no,id from public.shipment_transports where shipment_id=pg_temp.id('shipment');
do $$ declare r record; begin
 for r in select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id
          where run.shipment_id=pg_temp.id('shipment') and st.sequence_order<=4 order by st.sequence_order loop
  perform public.change_shipment_stage_status(r.id,'completed');
 end loop;
end $$;

-- ---------- the next stage waits for its documents ----------
select public.run_logist(pg_temp.id('shipment'));
do $$ begin
 assert not exists(select 1 from public.logist_proposals where shipment_id=pg_temp.id('shipment') and kind='complete_stage'),
  'no proposal to complete «Получение и проверка документов» without the invoice and packing list';
 assert (select count(*) from public.logist_proposals where shipment_id=pg_temp.id('shipment') and kind='follow_up_task' and title like 'Уточнить прибытие%')=2,
  'two vehicles are past their planned arrival';
 assert exists(select 1 from public.notifications where recipient_user_id='ed000000-0000-4000-8000-000000000001' and type='system' and title='Логист: новые предложения'),
  'the responsible employee is notified';
end $$;

reset role;
set session_replication_role=replica;
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select d.id::uuid,(select id from public.document_types where code=d.code),d.title,'approved','manual_upload','ed000000-0000-4000-8000-000000000001',1
from (values ('ed500000-0000-4000-8000-000000000001','invoice','Инвойс 7'),('ed500000-0000-4000-8000-000000000002','packing_list','Упаковочный лист 7'),
             ('ed500000-0000-4000-8000-000000000003','driver_document','Права водителя'),('ed500000-0000-4000-8000-000000000004','driver_document','Неизвестная машина')) d(id,code,title);
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select ('ed51000'||n||'-0000-4000-8000-000000000001')::uuid,('ed50000'||'0-0000-4000-8000-00000000000'||n)::uuid,1,
 'documents/ed500000-0000-4000-8000-00000000000'||n||'/00000000000000000000000000000001-d'||n||'.pdf','d'||n||'.pdf','application/pdf',10,true,'ed000000-0000-4000-8000-000000000001'
from generate_series(1,4) n;
insert into public.document_links(document_id,entity_type,entity_id,created_by)
select ('ed50000'||'0-0000-4000-8000-00000000000'||n)::uuid,'shipment',pg_temp.id('shipment'),'ed000000-0000-4000-8000-000000000001' from generate_series(1,4) n;
-- Recognised driver documents, not yet bound to a vehicle: one names vehicle 2 (written differently), one no vehicle.
insert into public.shipment_source_extractions(id,shipment_id,document_id,document_version_id,source_kind,status,extracted_data,extractor_version,requested_by)
values
 ('ed600000-0000-4000-8000-000000000003',pg_temp.id('shipment'),'ed500000-0000-4000-8000-000000000003','ed510003-0000-4000-8000-000000000001','driver_document','extracted','{"vehicle_plate":"222 bbb 22","driver_name":"Петров"}','rules-test','ed000000-0000-4000-8000-000000000001'),
 ('ed600000-0000-4000-8000-000000000004',pg_temp.id('shipment'),'ed500000-0000-4000-8000-000000000004','ed510004-0000-4000-8000-000000000001','driver_document','extracted','{"vehicle_plate":"999ZZZ99"}','rules-test','ed000000-0000-4000-8000-000000000001');
set session_replication_role=origin;

set role authenticated;
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);
select public.run_logist(pg_temp.id('shipment'));
do $$ begin
 assert exists(select 1 from public.logist_proposals where shipment_id=pg_temp.id('shipment') and kind='complete_stage' and status='pending'
               and title='Завершить этап «Получение и проверка документов»' and reason like '%Инвойс%'),
  'documents are attached: Logist proposes the stage';
 assert (select action->>'transport_id' from public.logist_proposals where kind='bind_document_vehicle' and action->>'extraction_id'='ed600000-0000-4000-8000-000000000003')=pg_temp.id('t2')::text,
  'the driver document is proposed for vehicle 2 (the empty vehicle 3 does not make it ambiguous)';
 assert not exists(select 1 from public.logist_proposals where kind='bind_document_vehicle' and action->>'extraction_id'='ed600000-0000-4000-8000-000000000004'),
  'a plate of no vehicle proposes nothing';
end $$;
-- Running again changes nothing.
do $$ declare n integer; begin
 select count(*) into n from public.logist_proposals where shipment_id=pg_temp.id('shipment');
 perform public.run_logist(pg_temp.id('shipment'));
 assert (select count(*) from public.logist_proposals where shipment_id=pg_temp.id('shipment'))=n,'proposals are not duplicated';
end $$;

-- ---------- access ----------
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000003',false);
do $$ begin assert not exists(select 1 from public.logist_proposals),'without documents.view nothing is visible'; end $$;
select pg_temp.fails($$select public.run_logist(pg_temp.id('shipment'))$$,'Нет доступа');
select pg_temp.fails($$select public.accept_logist_proposal('00000000-0000-4000-8000-000000000000')$$,'Нет доступа');
-- Nobody writes the queue directly.
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$update public.logist_proposals set status='accepted'$$,'permission denied');
select pg_temp.fails($$insert into public.logist_proposals(shipment_id,kind,title,reason,action,dedupe_key) values(pg_temp.id('shipment'),'complete_stage','x','x','{}','x')$$,'permission denied');
-- Deciding needs the right of the action itself.
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000002',false);
select pg_temp.fails($$select public.accept_logist_proposal(pg_temp.proposal('complete_stage','%'))$$,'Недостаточно прав');
select pg_temp.fails($$select public.reject_logist_proposal(pg_temp.proposal('complete_stage','%'),'нет')$$,'Недостаточно прав');

-- ---------- accept: the same function as the employee's button ----------
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);
do $$ declare r jsonb; v_run uuid; begin
 v_run := (select (action->>'stage_run_id')::uuid from public.logist_proposals where id=pg_temp.proposal('complete_stage','%'));
 r := public.accept_logist_proposal(pg_temp.proposal('complete_stage','%'));
 assert r->>'status'='accepted',r::text;
 assert (select status='completed' from public.shipment_stage_runs where id=v_run),'the stage is completed';
 assert exists(select 1 from public.shipment_stage_history where stage_run_id=v_run and to_status='completed' and changed_by='ed000000-0000-4000-8000-000000000001'),
  'the stage history names the employee who accepted';
 assert (select decided_by='ed000000-0000-4000-8000-000000000001' and decided_at is not null from public.logist_proposals where id=pg_temp.proposal('complete_stage','%')),'decision recorded';
 r := public.accept_logist_proposal(pg_temp.proposal('bind_document_vehicle','%'));
 assert (select shipment_transport_id=pg_temp.id('t2') from public.shipment_source_extractions where id='ed600000-0000-4000-8000-000000000003'),'document bound to vehicle 2';
end $$;
select pg_temp.fails($$select public.accept_logist_proposal(pg_temp.proposal('complete_stage','%'))$$,'уже рассмотрено');

-- A follow-up task goes to the responsible employee when a manager accepts it ...
do $$ declare r jsonb; begin
 r := public.accept_logist_proposal(pg_temp.proposal('follow_up_task','Уточнить прибытие автомобиля №1'));
 assert (select assignee_user_id='ed000000-0000-4000-8000-000000000001' and priority='high' and shipment_id=pg_temp.id('shipment')
           and title like 'Уточнить прибытие автомобиля №1 поставки %' and due_at > now()
         from public.tasks where id=(r->'result'->>'task_id')::uuid),'task for the responsible employee, due tomorrow';
end $$;
-- ... and to the employee who accepts it when they may not assign tasks to others.
reset role;
set session_replication_role=replica;
update public.shipment_stage_runs set due_at=now()-interval '2 days'
where id=(select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id
          where run.shipment_id=pg_temp.id('shipment') and st.code='transport_preparation');
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000002',false);
select public.run_logist(pg_temp.id('shipment'));
do $$ declare r jsonb; begin
 r := public.accept_logist_proposal(pg_temp.proposal('follow_up_task','Этап «Подготовка перевозки» просрочен'));
 assert (select assignee_user_id='ed000000-0000-4000-8000-000000000002' and stage_run_id is not null from public.tasks where id=(r->'result'->>'task_id')::uuid),
  'without tasks.manage the employee takes the task';
 perform public.run_logist(pg_temp.id('shipment'));
 assert not exists(select 1 from public.logist_proposals where status='pending' and title like 'Этап «Подготовка перевозки» просрочен%'),
  'an open task for the stage stops the proposal';
end $$;

-- ---------- reject: not proposed again ----------
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$select public.reject_logist_proposal(pg_temp.proposal('follow_up_task','Уточнить прибытие автомобиля №2'),repeat('x',501))$$,'500');
select public.reject_logist_proposal(pg_temp.proposal('follow_up_task','Уточнить прибытие автомобиля №2'),'Перевозчик уже сообщил новую дату');
select public.run_logist(pg_temp.id('shipment'));
do $$ begin
 assert (select status='rejected' and decision_note='Перевозчик уже сообщил новую дату' from public.logist_proposals where id=pg_temp.proposal('follow_up_task','Уточнить прибытие автомобиля №2')),'rejected with the note';
 assert (select count(*)=1 from public.logist_proposals where title like 'Уточнить прибытие автомобиля №2%'),'a rejected situation is not proposed again';
end $$;

-- ---------- obsolete: the situation passed ----------
reset role;
set session_replication_role=replica;
update public.shipment_transports set planned_arrival_date=current_date-1 where id=pg_temp.id('t2');
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);
select public.run_logist(pg_temp.id('shipment'));
do $$ declare v uuid := pg_temp.proposal('follow_up_task','Уточнить прибытие автомобиля №2'); begin
 assert (select status='pending' from public.logist_proposals where id=v),'a new planned day is a new situation';
 perform public.change_shipment_transport_status(pg_temp.id('t2'),'arrived');
 -- Accepting re-checks the situation first.
 assert (public.accept_logist_proposal(v))->>'status'='obsolete','the vehicle arrived: nothing to do';
 assert (select status='obsolete' from public.logist_proposals where id=v),'marked obsolete';
 assert not exists(select 1 from public.tasks where title like 'Уточнить прибытие автомобиля №2%'),'no task was created';
end $$;

-- ---------- a held or closed shipment proposes nothing ----------
select public.change_shipment_operational_state(pg_temp.id('shipment'),'hold','Ждём решения клиента');
select public.run_logist(pg_temp.id('shipment'));
do $$ begin
 assert not exists(select 1 from public.logist_proposals where shipment_id=pg_temp.id('shipment') and status='pending'),'pending proposals become obsolete on hold';
end $$;

reset role;
rollback;
