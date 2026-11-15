\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'eb000000-0000-4000-8000-000000000001',id,'allow','Freight source test','eb000000-0000-4000-8000-000000000001'
from public.permissions where code in('carriers.directory.read','carriers.directory.manage');
set local session_replication_role=replica;
update public.shipment_source_extractions set confirmed_data='{"driver_name":"Тестовый водитель OCR","driver_phone":"+70000000000","iin":"PRIVATE-IIN","driver_document":"PRIVATE-DOC"}' where id='eb601000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
create temp table source_before as select id,status,confirmed_data,reviewed_by,reviewed_at from public.shipment_source_extractions;
create temp table freight_source_proposal(value jsonb);
grant select,insert on freight_source_proposal to authenticated;
create function pg_temp.freight_refuses(stmt text) returns void language plpgsql as $$begin
 begin execute stmt;exception when others then
  if sqlerrm ~ 'Источник (недоступен|изменился)' then return;end if;raise;
 end;raise exception 'Expected stale or detached source rejection';
end$$;
grant execute on function pg_temp.freight_refuses(text) to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
insert into freight_source_proposal select public.freight_source_preview('extraction','eb601000-0000-4000-8000-000000000001');
do $$begin assert (select value->'suggested'->>'full_name'='Тестовый водитель OCR' and value::text !~ 'PRIVATE-IIN|PRIVATE-DOC' from freight_source_proposal);end$$;
savepoint changed_version;
reset role;
set local session_replication_role=replica;
update public.documents set current_version=2 where id='eb501000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
set local role authenticated;
select pg_temp.freight_refuses($q$select public.freight_source_preview('extraction','eb601000-0000-4000-8000-000000000001')$q$);
do $$begin assert not exists(select 1 from jsonb_array_elements(public.freight_source_choices('extraction')) d where d->>'id'='eb601000-0000-4000-8000-000000000001');end$$;
rollback to changed_version;
savepoint detached;
reset role;
update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001' where document_id='eb501000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.freight_refuses($q$select public.freight_source_preview('extraction','eb601000-0000-4000-8000-000000000001')$q$);
rollback to detached;
savepoint rejected;
reset role;
set local session_replication_role=replica;
update public.documents set status='rejected' where id='eb501000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
set local role authenticated;
select pg_temp.freight_refuses($q$select public.freight_source_preview('extraction','eb601000-0000-4000-8000-000000000001')$q$);
rollback to rejected;
savepoint changed_reading;
reset role;
set local session_replication_role=replica;
update public.shipment_source_extractions set confirmed_data=confirmed_data||'{"driver_name":"Новый водитель"}',updated_at=clock_timestamp() where id='eb601000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
set local role authenticated;
select pg_temp.freight_refuses($q$select public.save_freight_directory('driver',gen_random_uuid(),null,0,
 jsonb_build_object('full_name','Тестовый водитель OCR','active',true,'source',jsonb_build_object('type','extraction','id','eb601000-0000-4000-8000-000000000001','stamp',(select value->>'stamp' from freight_source_proposal))),'Устаревший источник')$q$);
rollback to changed_reading;
select public.save_freight_directory('driver',gen_random_uuid(),null,0,
 jsonb_build_object('full_name','Тестовый водитель OCR','active',true,'source',jsonb_build_object('type','extraction','id','eb601000-0000-4000-8000-000000000001','stamp',(select value->>'stamp' from freight_source_proposal))),'Подтверждённый источник');
reset role;
do $$begin
 assert not exists((select id,status,confirmed_data,reviewed_by,reviewed_at from public.shipment_source_extractions except select * from source_before)
 union all(select * from source_before except select id,status,confirmed_data,reviewed_by,reviewed_at from public.shipment_source_extractions));
end$$;
rollback;
