\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
create function pg_temp.refuses(sql text) returns void language plpgsql as $$
begin
 begin execute sql; exception when others then return; end;
 raise exception 'Expected refusal: %',sql;
end $$;
grant execute on function pg_temp.refuses(text) to authenticated;
create temp table original_confirmations as select id,status,confirmed_data,reviewed_by,reviewed_at from public.shipment_source_extractions;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000001','Синтетическая CMR первого автомобиля');
select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000001','Повтор после потери ответа');
select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000002','Уточнено по синтетическому оригиналу');
do $$begin
 assert (select count(*) from public.shipment_source_context_history)=2;
 assert (select bool_and(changed_by=auth.uid()) from public.shipment_source_context_history);
end $$;
select pg_temp.refuses($q$select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001',null,'')$q$);
select pg_temp.refuses($q$select public.assign_source_extraction_transport('eb601000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000002','Перенос старого подтверждения запрещён')$q$);
savepoint detached;
update public.document_links set removed_at=now(),removed_by=auth.uid() where document_id='eb503000-0000-4000-8000-000000000001';
-- Both signatures must reject a detached source; legacy RPC cannot bypass the guard.
select pg_temp.refuses($q$select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001',null)$q$);
select pg_temp.refuses($q$select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001',null,'Изменение после снятия связи')$q$);
rollback to detached;
savepoint replaced;
reset role;
set local session_replication_role=replica;
update public.documents set current_version=2 where id='eb503000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
set role authenticated;
select pg_temp.refuses($q$select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001',null,'Изменение после замены версии')$q$);
rollback to replaced;
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'eb000000-0000-4000-8000-000000000001',id,'deny','Context test','eb000000-0000-4000-8000-000000000001'
from public.permissions where code='documents.view';
set role authenticated;
select pg_temp.refuses($q$select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001',null,'Личный запрет')$q$);
do $$begin assert (select count(*) from public.shipment_source_context_history)=0; end $$;
reset role;
do $$begin
 assert not exists((select id,status,confirmed_data,reviewed_by,reviewed_at from public.shipment_source_extractions except select * from original_confirmations)
 union all (select * from original_confirmations except select id,status,confirmed_data,reviewed_by,reviewed_at from public.shipment_source_extractions));
 assert not has_table_privilege('service_role','public.shipment_source_context_history','select');
end $$;
rollback;
