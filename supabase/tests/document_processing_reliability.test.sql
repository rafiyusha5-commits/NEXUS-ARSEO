\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
create function pg_temp.refuses(sql text) returns void language plpgsql as $$
begin begin execute sql; exception when others then return; end; raise exception 'Expected refusal: %',sql; end $$;
grant execute on function pg_temp.refuses(text) to authenticated;
insert into private.drive_gateway_config(id,secret_sha256) values(true,encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'))
on conflict(id) do update set secret_sha256=excluded.secret_sha256;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select set_config('request.headers',jsonb_build_object('x-nexus-drive-gateway',repeat('a',64))::text,true);
do $$declare r jsonb;begin
 r:=public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001','scan');
 assert r->>'action'='run';
 assert (public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001','scan')->>'action')='busy';
 assert (public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000001','scan')->>'action')='busy';
end $$;
select pg_temp.refuses($q$select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000001',1,'finished','completed')$q$);
select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Synthetic_folder_1','Synthetic');
select public.scan_shipment_drive_folder(shipment_id,generation,'[]') from public.shipment_drive_folders where shipment_id='eb300000-0000-4000-8000-000000000001';
select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000001',1,'finished','completed');
do $$begin
 assert (public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001','scan')->>'action')='completed';
end $$;
select public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000001','import','Synthetic_file','1');
update public.shipment_drive_operations set lease_until=clock_timestamp()-interval '1 second' where id='dc000000-0000-4000-8000-000000000002';
do $$declare r jsonb;begin
 r:=public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000001','import','Synthetic_file','1');
 assert r->>'action'='run' and (r->>'attempt')::int=2;
end $$;
select pg_temp.refuses($q$select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000002',1,'finished','completed')$q$);
select pg_temp.refuses($q$select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000002',2,'finished','completed')$q$);
select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000002',2,'registering','needs_action','SAVE_UNCERTAIN');
-- The reconciler's explicit byte comparison and link-only action share durable
-- progress, but a receipt alone must never certify content or create a document.
select public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000003','eb300000-0000-4000-8000-000000000001','check','Synthetic_file','1');
select pg_temp.refuses($q$select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000003',1,'finished','completed')$q$);
select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000003',1,'downloading','failed','SOURCE_UNAVAILABLE');
select public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000004','eb300000-0000-4000-8000-000000000001','link','Synthetic_file','1');
select pg_temp.refuses($q$select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000004',1,'finished','completed')$q$);
select public.record_shipment_drive_operation('dc000000-0000-4000-8000-000000000004',1,'registering','needs_action','SAVE_UNCERTAIN');
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'eb000000-0000-4000-8000-000000000001',id,'deny','Synthetic deny','eb000000-0000-4000-8000-000000000001' from public.permissions where code='documents.drive.view';
set role authenticated;
select pg_temp.refuses($q$select public.begin_shipment_drive_operation('dc000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001','scan')$q$);
do $$begin assert (select count(*) from public.shipment_drive_operations)=0; end $$;
reset role;
do $$begin assert not has_table_privilege('service_role','public.shipment_drive_operations','select'); end $$;
rollback;
