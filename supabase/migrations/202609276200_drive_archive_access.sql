-- Apply after 6100. Employee JWT + existing RLS remain mandatory; no service_role
-- read grants are added. The server DAL alone may cross the catalog gateway.
begin;
select pg_advisory_xact_lock(59260001);
create table if not exists private.drive_gateway_config (
  id boolean primary key default true check(id),
  secret_sha256 text not null check(secret_sha256 ~ '^[0-9a-f]{64}$')
);
alter table private.drive_gateway_config enable row level security;
revoke all on private.drive_gateway_config from public,anon,authenticated,service_role;

create or replace function private.drive_gateway_allowed() returns boolean
language plpgsql stable security definer set search_path='' as $$
declare headers jsonb; secret text;
begin
  headers := nullif(current_setting('request.headers',true),'')::jsonb;
  secret := headers->>'x-nexus-drive-gateway';
  if secret is null or secret !~ '^[0-9a-f]{64}$' then return false; end if;
  return exists(select 1 from private.drive_gateway_config c
    where c.id and c.secret_sha256=encode(sha256(convert_to(secret,'UTF8')),'hex'));
exception when others then return false;
end$$;
revoke all on function private.drive_gateway_allowed() from public,anon,authenticated,service_role;
grant execute on function private.drive_gateway_allowed() to authenticated;

-- Restrictive policies AND with ALL existing/future permissive policies.
drop policy if exists drive_catalog_server_only on public.drive_catalog_files;
create policy drive_catalog_server_only on public.drive_catalog_files as restrictive
  for select to authenticated using ((select private.drive_gateway_allowed()));
drop policy if exists drive_text_server_only on public.drive_catalog_text;
create policy drive_text_server_only on public.drive_catalog_text as restrictive
  for select to authenticated using ((select private.drive_gateway_allowed()));

-- Capture text-search authority in the SAME statement snapshot as the results.
-- The DAL carries it through later provider, rendering and delivery checks.
create or replace function public.search_drive_catalog(p_query text,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare q tsquery;result jsonb;v_total bigint;
begin
 if p_query is null or length(p_query)>120 or p_offset<0 or p_offset>10000 then raise exception 'DRIVE_BAD_QUERY';end if;
 q:=plainto_tsquery('simple',translate(p_query,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'));
 select count(*) into v_total from public.drive_catalog_files f where to_tsvector('simple',translate(f.name||' '||f.folder_path,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'))@@q or exists(select 1 from public.drive_catalog_text t where t.file_id=f.file_id and t.search_vector@@q);
 select coalesce(jsonb_agg(x),'[]'::jsonb) into result from (
  select f.file_id as id,f.name,f.folder_path as path,f.mime_type as "mimeType",f.source_modified_at as "modifiedTime",f.ancestor_ids as ancestors,f.indexed_at as "indexedAt",f.content_status as "contentStatus",f.text_method as "textMethod",f.ocr_confidence as "ocrConfidence",f.ocr_pages as "ocrPages",f.ocr_error as "ocrError"
  from public.drive_catalog_files f where to_tsvector('simple',translate(f.name||' '||f.folder_path,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'))@@q or exists(select 1 from public.drive_catalog_text t where t.file_id=f.file_id and t.search_vector@@q)
  order by f.name,f.file_id offset p_offset limit 20
 ) x;
 return jsonb_build_object('files',result,'total',v_total,'truncated',v_total>p_offset+20,'catalog',true,
  'textSearch',private.has_permission('documents.drive.text.view') and private.has_permission('prices.purchase.view'),
  'ready',exists(select 1 from public.drive_catalog_runs where status in ('extracting','completed')));
end$$;
revoke all on function public.search_drive_catalog(text,integer) from public,anon,authenticated,service_role;
grant execute on function public.search_drive_catalog(text,integer) to authenticated;

-- Persistent telemetry never keeps questions or model-controlled parameters.
-- Keep the existing validator; this trigger also covers late finishes from old workers.
create or replace function private.agent_strip_trace_content() returns trigger
language plpgsql set search_path='' as $$
begin
  new.question_excerpt := null;
  select coalesce(jsonb_agg(e || '{"params":{}}'::jsonb order by n),'[]'::jsonb)
    into new.tools from jsonb_array_elements(new.tools) with ordinality as t(e,n);
  return new;
end$$;
revoke all on function private.agent_strip_trace_content() from public,anon,authenticated,service_role;
drop trigger if exists agent_strip_trace_content on public.agent_runs;
create trigger agent_strip_trace_content before insert or update on public.agent_runs
  for each row execute function private.agent_strip_trace_content();
update public.agent_runs set question_excerpt=null where id is not null;

-- Purge pre-fix derived text, including OCR; retain source metadata and OCR engine.
-- Cancel outstanding receipts so an old worker cannot restore its captured text.
-- Guard the one-time cleanup against migration reapplication.
create table if not exists private.drive_access_cleanup (
  version integer primary key, completed_at timestamptz not null default now()
);
revoke all on private.drive_access_cleanup from public,anon,authenticated,service_role;
do $$begin
  if not exists(select 1 from private.drive_access_cleanup where version=1) then
    update public.drive_catalog_runs set status='failed',finished_at=now()
      where status in ('scanning','extracting');
    delete from private.drive_catalog_sync where id=true;
    update public.drive_catalog_files set
      content_status=case when text_method='ocr' or mime_type like 'image/%' then 'needs_ocr' else 'pending' end,
      text_indexed_at=null,text_method=null,ocr_attempts=0,ocr_confidence=null,ocr_pages=null,ocr_error=null
      where root_id='1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm';
    delete from public.drive_catalog_text where file_id is not null;
    insert into private.drive_access_cleanup(version) values(1);
  end if;
end$$;
notify pgrst,'reload schema';
commit;
