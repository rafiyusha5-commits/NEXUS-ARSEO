-- 202611220300: a later check of a Drive folder that finds new files notifies the shipment's responsible employee once
-- per check; the first check, an unchanged check and a check by the responsible employee notify nobody. Synthetic data.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
insert into private.drive_gateway_config(id,secret_sha256) values(true,encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'))
on conflict(id) do update set secret_sha256=excluded.secret_sha256;
-- The responsible employee is somebody other than the one who checks the folder.
set session_replication_role=replica;
update public.shipments set responsible_user_id='eb000000-0000-4000-8000-000000000002' where id='eb300000-0000-4000-8000-000000000001';
set session_replication_role=origin;
create function pg_temp.scan(p_files text) returns void language sql as $$
 select public.scan_shipment_drive_folder(shipment_id,generation,
  (select jsonb_agg(jsonb_build_object('file_id',f||'_123456789','name',f||'.pdf','path','Закуп / '||f||'.pdf','mime_type','application/pdf','revision','1','size',10))
   from unnest(string_to_array(p_files,',')) f))
 from public.shipment_drive_folders where shipment_id='eb300000-0000-4000-8000-000000000001'
$$;
create function pg_temp.notes() returns bigint language sql as $$
 select count(*) from public.notifications where type='drive_new_files' and shipment_id='eb300000-0000-4000-8000-000000000001'
$$;
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select set_config('request.headers',jsonb_build_object('x-nexus-drive-gateway',repeat('a',64))::text,true);
select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Folder_123456789','Shipment');
-- 1. The first check: every file is new, nobody is notified.
select pg_temp.scan('Alpha');
reset role;
do $$begin
 assert pg_temp.notes()=0,'first check notifies nobody';
 assert (select first_seen_at is not null from public.shipment_drive_files where file_id='Alpha_123456789'),'first seen is recorded';
end $$;
set role authenticated;
-- 2. A later check with two new files: one notification to the responsible employee.
select pg_temp.scan('Alpha,Beta,Gamma');
reset role;
do $$declare n public.notifications%rowtype;begin
 assert pg_temp.notes()=1,'one notification per check';
 select * into n from public.notifications where type='drive_new_files';
 assert n.recipient_user_id='eb000000-0000-4000-8000-000000000002';
 assert n.entity_type='shipment_drive_folder' and n.entity_id='eb300000-0000-4000-8000-000000000001';
 assert position('Beta' in n.body)=0 and position('DQ-1' in n.body)>0,'shipment number, no file names';
end $$;
set role authenticated;
-- 3. An unchanged check notifies nobody; the next new file is a new notification.
select pg_temp.scan('Alpha,Beta,Gamma');
reset role; do $$begin assert pg_temp.notes()=1,'unchanged check'; end $$; set role authenticated;
select pg_temp.scan('Alpha,Beta,Gamma,Delta');
reset role; do $$begin assert pg_temp.notes()=2,'new file in a later check'; end $$;
-- 4. The responsible employee who checks the folder sees the result on the screen: no notification.
set session_replication_role=replica;
update public.shipments set responsible_user_id='eb000000-0000-4000-8000-000000000001' where id='eb300000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
select pg_temp.scan('Alpha,Beta,Gamma,Delta,Epsilon');
reset role;
do $$begin
 assert pg_temp.notes()=2,'own check';
 assert not has_function_privilege('authenticated','private.notify_drive_new_file()','execute');
end $$;
\echo drive_new_files: all checks passed
rollback;
