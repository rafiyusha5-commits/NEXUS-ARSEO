\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
create function pg_temp.refuses(q text) returns void language plpgsql as $$
begin begin execute q; exception when others then return; end; raise exception 'Expected refusal: %',q; end $$;
grant execute on function pg_temp.refuses(text) to authenticated;
insert into private.drive_gateway_config(id,secret_sha256) values(true,encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'))
on conflict(id) do update set secret_sha256=excluded.secret_sha256;
create temp table before_items as select * from public.shipment_items;
create temp table before_sources as select * from public.shipment_source_extractions;
create temp table before_movements as select * from public.inventory_movements;
create temp table before_documents as select * from public.documents;
create temp table before_expenses as select * from public.expenses;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select set_config('request.headers','{}',true);
select pg_temp.refuses($q$select public.save_historical_shipment_draft('ef000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001',false,0,'[]')$q$);
select set_config('request.headers',jsonb_build_object('x-nexus-drive-gateway',repeat('a',64))::text,true);
select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Synthetic_folder_123','Synthetic only');
select public.scan_shipment_drive_folder(shipment_id,generation,'[]') from public.shipment_drive_folders where shipment_id='eb300000-0000-4000-8000-000000000001';
select set_config('tests.choices',(select jsonb_agg(jsonb_build_object('id',id,'version',document_version_id,'updated',updated_at,'group','procurement','variant','original'))::text
 from public.shipment_source_extractions where id='eb601000-0000-4000-8000-000000000001'),true);
select public.save_historical_shipment_draft('ef000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001',false,0,current_setting('tests.choices')::jsonb);
-- Lost response, reopen, rescan and repeat: same draft/revision, no accounting side effects.
select public.scan_shipment_drive_folder(shipment_id,generation,'[]') from public.shipment_drive_folders where shipment_id='eb300000-0000-4000-8000-000000000001';
select public.save_historical_shipment_draft('ef000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001',false,0,current_setting('tests.choices')::jsonb);
do $$ begin if (select revision from public.historical_shipment_drafts where id='ef000000-0000-4000-8000-000000000001')<>1 then raise exception 'Duplicate save'; end if; end $$;
select public.save_historical_shipment_draft('ef000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001',true,1,current_setting('tests.choices')::jsonb);
select pg_temp.refuses($q$select public.save_historical_shipment_draft('ef000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001',false,null,'[]')$q$);
select pg_temp.refuses($q$select public.save_historical_shipment_draft('ef000000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001',false,1,'[]')$q$);
-- No arbitrary values, fake confirmation flags, duplicate references or stale extraction.
select pg_temp.refuses($q$update public.historical_shipment_drafts set revision=revision+1,choices=jsonb_build_array((choices->0)||'{"confirmed":true}')$q$);
select pg_temp.refuses($q$update public.historical_shipment_drafts set revision=revision+1,choices=choices||choices$q$);
select pg_temp.refuses($q$update public.historical_shipment_drafts set revision=revision+1,choices=jsonb_set(choices,'{0,updated}','"2000-01-01"')$q$);
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000003',true);
select pg_temp.refuses($q$select public.save_historical_shipment_draft('ef000000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000001',false,0,'[]')$q$);
do $$ begin if exists(select 1 from public.historical_shipment_drafts) then raise exception 'Deny leaked draft'; end if; end $$;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000002',true);
do $$ begin if exists(select 1 from public.historical_shipment_drafts) then raise exception 'Other owner leaked draft'; end if; end $$;
reset role;
-- Replace source while a form is open; old choices cannot be saved as current.
savepoint changed_source;
set session_replication_role=replica;
update public.documents set archived_at=now(),archived_by='eb000000-0000-4000-8000-000000000001',archive_reason='Synthetic archive' where id='eb501000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select pg_temp.refuses($q$select public.save_historical_shipment_draft('ef000000-0000-4000-8000-000000000003','eb300000-0000-4000-8000-000000000001',false,0,current_setting('tests.choices')::jsonb)$q$);
reset role;
rollback to changed_source;
do $$ begin
 if exists((select * from before_items except select * from public.shipment_items) union all (select * from public.shipment_items except select * from before_items)) then raise exception 'Items changed'; end if;
 if exists((select * from before_sources except select * from public.shipment_source_extractions) union all (select * from public.shipment_source_extractions except select * from before_sources)) then raise exception 'Sources changed'; end if;
 if exists((select * from before_movements except select * from public.inventory_movements) union all (select * from public.inventory_movements except select * from before_movements)) then raise exception 'Inventory changed'; end if;
 if exists((select * from before_documents except select * from public.documents) union all (select * from public.documents except select * from before_documents)) then raise exception 'Documents changed'; end if;
 if exists((select * from before_expenses except select * from public.expenses) union all (select * from public.expenses except select * from before_expenses)) then raise exception 'Finance changed'; end if;
 if has_table_privilege('service_role','public.historical_shipment_drafts','SELECT') then raise exception 'service role grant'; end if;
end $$;
rollback;
