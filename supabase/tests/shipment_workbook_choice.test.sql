-- 202611230100: the chosen «Вн расчеты» of a shipment — only a present Google table of its folder, replaced by a new
-- choice, refused without shipments.update, readable with shipments.view. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
insert into private.drive_gateway_config(id,secret_sha256) values(true,encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'))
on conflict(id) do update set secret_sha256=excluded.secret_sha256;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select set_config('request.headers',jsonb_build_object('x-nexus-drive-gateway',repeat('a',64))::text,true);
select public.bind_shipment_drive_folder('eb300000-0000-4000-8000-000000000001','Folder_123456789','Shipment');
select public.scan_shipment_drive_folder(shipment_id,generation,
 '[{"file_id":"Workbook_one_123","name":"Вн расчеты AB-50","path":"Вн расчеты AB-50","mime_type":"application/vnd.google-apps.spreadsheet","revision":"1","size":null},
   {"file_id":"Workbook_two_123","name":"Копия для расчетов Вн расчеты AB-50","path":"Копия","mime_type":"application/vnd.google-apps.spreadsheet","revision":"1","size":null},
   {"file_id":"Invoice_pdf_1234","name":"invoice.pdf","path":"invoice.pdf","mime_type":"application/pdf","revision":"1","size":10}]')
 from public.shipment_drive_folders where shipment_id='eb300000-0000-4000-8000-000000000001';
-- 1. A table of the folder is chosen, then replaced by another one.
select public.choose_shipment_workbook('eb300000-0000-4000-8000-000000000001','Workbook_one_123');
select public.choose_shipment_workbook('eb300000-0000-4000-8000-000000000001','Workbook_two_123');
do $$begin
 assert (select file_id from public.shipment_workbook_choices where shipment_id='eb300000-0000-4000-8000-000000000001')='Workbook_two_123','the last choice wins';
 assert (select count(*) from public.shipment_workbook_choices)=1;
end $$;
-- 2. Not a table, not in the folder, another shipment's folder: refused.
select pg_temp.fails($q$select public.choose_shipment_workbook('eb300000-0000-4000-8000-000000000001','Invoice_pdf_1234')$q$,'не найдена');
select pg_temp.fails($q$select public.choose_shipment_workbook('eb300000-0000-4000-8000-000000000001','Somewhere_else_1')$q$,'не найдена');
select pg_temp.fails($q$select public.choose_shipment_workbook('eb300000-0000-4000-8000-000000000002','Workbook_one_123')$q$,'не найдена');
select pg_temp.fails($q$insert into public.shipment_workbook_choices(shipment_id,file_id) values('eb300000-0000-4000-8000-000000000002','Workbook_one_123')$q$,'permission denied');
-- 3. Without shipments.update the choice is readable but not changeable.
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000003',true);
do $$begin assert exists(select 1 from public.shipment_workbook_choices),'readable with shipments.view'; end $$;
select pg_temp.fails($q$select public.choose_shipment_workbook('eb300000-0000-4000-8000-000000000001','Workbook_one_123')$q$,'Недостаточно прав');
reset role;
do $$begin
 assert not has_table_privilege('anon','public.shipment_workbook_choices','select');
 assert not has_function_privilege('anon','public.choose_shipment_workbook(uuid,text)','execute');
end $$;
\echo shipment_workbook_choice: all checks passed
rollback;
