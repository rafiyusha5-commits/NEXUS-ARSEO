-- Text access is explicit and separate from metadata and file retrieval.
insert into public.permissions(code,module,action,name,description) values
 ('documents.drive.text.view','documents','drive_text_view','Архив Google Drive: текст','Чтение извлечённого текста. Дополнительно нужны доступ к архиву и право на закупочные цены: документы пока не классифицированы по финансовым полям.')
on conflict(code) do update set name=excluded.name,description=excluded.description;
insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='documents.drive.text.view' and r.audience='internal' and r.code in ('administrator','director')
on conflict(role_id,permission_id) do nothing;
-- Nexus-owned catalog. Original Drive objects are never mutated.
create table if not exists public.drive_catalog_files (
 file_id text primary key check(file_id ~ '^[A-Za-z0-9_-]{10,120}$'),
 root_id text not null default '1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm' check(root_id='1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm'),
 name text not null check(length(name)<=500), folder_path text not null check(length(folder_path)<=4000),
 mime_type text not null, size_bytes bigint, ancestor_ids text[] not null,
 source_modified_at timestamptz not null, seen_run uuid not null, present boolean not null default true,
 content_status text not null default 'pending' check(content_status in ('pending','readable','needs_ocr','unsupported','error','changed','too_large')),
 indexed_at timestamptz not null default now(), text_indexed_at timestamptz
);
create table if not exists public.drive_catalog_text (
 file_id text primary key references public.drive_catalog_files(file_id),
 source_modified_at timestamptz not null, body text not null check(length(body)<=60000),
 truncated boolean not null default false, indexed_at timestamptz not null default now(),
 search_vector tsvector generated always as (to_tsvector('simple',translate(body,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'))) stored
);
create index if not exists drive_catalog_text_search on public.drive_catalog_text using gin(search_vector);
create index if not exists drive_catalog_metadata_search on public.drive_catalog_files using gin(to_tsvector('simple',translate(name||' '||folder_path,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя')));
create table if not exists public.drive_catalog_runs (
 id uuid primary key default pg_catalog.gen_random_uuid(), user_id uuid not null references public.profiles(id),
 status text not null default 'scanning' check(status in ('scanning','extracting','completed','failed')),
 started_at timestamptz not null default now(), finished_at timestamptz, pages integer not null default 0,
 files integer not null default 0, readable integer not null default 0, unreadable integer not null default 0
);
create table if not exists private.drive_catalog_sync (
 id boolean primary key default true check(id), run_id uuid not null references public.drive_catalog_runs(id),
 frontier jsonb not null, claim jsonb, token uuid, lease_until timestamptz
);
alter table public.drive_catalog_files enable row level security;
alter table public.drive_catalog_text enable row level security;
alter table public.drive_catalog_runs enable row level security;
alter table private.drive_catalog_sync enable row level security;
revoke all on public.drive_catalog_files,public.drive_catalog_text,public.drive_catalog_runs from public,anon,authenticated,service_role;
revoke all on private.drive_catalog_sync from public,anon,authenticated,service_role;
grant select on public.drive_catalog_files,public.drive_catalog_text,public.drive_catalog_runs to authenticated;
drop policy if exists drive_catalog_read on public.drive_catalog_files;
create policy drive_catalog_read on public.drive_catalog_files for select to authenticated using (
 present and (select private.is_employee()) and (select private.has_permission('agent.use'))
 and (select private.has_permission('documents.view')) and (select private.has_permission('documents.drive.view'))
);
drop policy if exists drive_catalog_run_read on public.drive_catalog_runs;
create policy drive_catalog_run_read on public.drive_catalog_runs for select to authenticated using (
 (select private.is_employee()) and (select private.has_permission('agent.use')) and (select private.has_permission('documents.view')) and (select private.has_permission('documents.drive.view'))
);
drop policy if exists drive_catalog_text_read on public.drive_catalog_text;
create policy drive_catalog_text_read on public.drive_catalog_text for select to authenticated using (
 (select private.has_permission('prices.purchase.view')) and (select private.has_permission('documents.drive.text.view')) and exists (
  select 1 from public.drive_catalog_files f where f.file_id=drive_catalog_text.file_id
  and f.content_status='readable' and f.source_modified_at=drive_catalog_text.source_modified_at
 )
);

-- Only the server imports external-source catalog data. Tools have SELECT/RLS only.
create or replace function public.drive_catalog_sync_step(p_user_id uuid,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.drive_catalog_sync%rowtype;r public.drive_catalog_runs%rowtype;item jsonb;f jsonb;v_id text;v_path text;v_anc text[];v_modified timestamptz;v_status text;v_token uuid;v_body text;v_count integer;
begin
 if not private.user_has_permission(p_user_id,'agent.use') or not private.user_has_permission(p_user_id,'documents.view') or not private.user_has_permission(p_user_id,'documents.drive.view') or not private.user_has_permission(p_user_id,'documents.drive.text.view')
 or not exists(select 1 from public.user_roles ur join public.app_roles ar on ar.id=ur.role_id where ur.user_id=p_user_id and ar.code in ('administrator','director') and (ur.expires_at is null or ur.expires_at>now())) then raise exception 'DRIVE_FORBIDDEN' using errcode='42501';end if;
 if p_operation is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>2000000 then raise exception 'DRIVE_BAD_REQUEST';end if;
 perform pg_advisory_xact_lock(59260001);
 select * into s from private.drive_catalog_sync where id for update;
 if s.run_id is not null then select * into r from public.drive_catalog_runs where id=s.run_id for update;end if;
 if p_operation='start' then
  if r.status in ('scanning','extracting') then return jsonb_build_object('status',r.status,'runId',r.id);end if;
  insert into public.drive_catalog_runs(user_id) values(p_user_id) returning * into r;
  insert into private.drive_catalog_sync(id,run_id,frontier) values(true,r.id,'[{"id":"1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm","path":"","depth":0,"ancestors":[],"page":""}]'::jsonb)
  on conflict(id) do update set run_id=excluded.run_id,frontier=excluded.frontier,claim=null,token=null,lease_until=null;
  return jsonb_build_object('status','scanning','runId',r.id);
 end if;
 if r.id is null then return jsonb_build_object('status','idle');end if;
 if p_operation='claim' then
  if r.status not in ('scanning','extracting') then return jsonb_build_object('status',r.status,'runId',r.id);end if;
  if s.lease_until>now() then return jsonb_build_object('status','busy');end if;
  if r.status='scanning' and jsonb_array_length(s.frontier)=0 then
   update public.drive_catalog_files set present=(seen_run=r.id);
   update public.drive_catalog_runs set status='extracting',files=(select count(*) from public.drive_catalog_files where present),
    readable=(select count(*) from public.drive_catalog_files where present and content_status='readable'),
    unreadable=(select count(*) from public.drive_catalog_files where present and content_status not in ('pending','readable')) where id=r.id;
   r.status:='extracting';
  end if;
  if r.status='scanning' then item:=s.frontier->0;
  else
   if not private.user_has_permission(p_user_id,'prices.purchase.view') then raise exception 'DRIVE_FORBIDDEN' using errcode='42501';end if;
   select jsonb_build_object('id',c.file_id,'path',c.folder_path,'name',c.name,'mimeType',c.mime_type,'size',c.size_bytes,'ancestors',to_jsonb(c.ancestor_ids),'modifiedTime',c.source_modified_at)
   into item from public.drive_catalog_files c where c.present and c.content_status='pending' order by c.file_id limit 1;
   if item is null then
    update public.drive_catalog_runs set status='completed',finished_at=now() where id=r.id;
    update private.drive_catalog_sync set claim=null,token=null,lease_until=null where id;
    return jsonb_build_object('status','completed','runId',r.id);
   end if;
  end if;
  v_token:=pg_catalog.gen_random_uuid();
  update private.drive_catalog_sync set claim=item,token=v_token,lease_until=now()+interval '90 seconds' where id;
  return jsonb_build_object('status',r.status,'runId',r.id,'token',v_token,'item',item);
 end if;
 if p_operation not in ('save_page','save_text','fail') or s.token is null or (p_payload->>'token') is distinct from s.token::text or (p_payload->>'runId') is distinct from r.id::text then raise exception 'DRIVE_BAD_CLAIM';end if;
 if p_operation='fail' then
  update public.drive_catalog_runs set status='failed',finished_at=now() where id=r.id;
 elsif p_operation='save_page' then
  if r.status<>'scanning' or jsonb_typeof(p_payload->'files') is distinct from 'array' or jsonb_array_length(p_payload->'files')>100 or jsonb_typeof(p_payload->'nextPage') is distinct from 'string' or length(p_payload->>'nextPage')>2000 or r.pages>=1000 then raise exception 'DRIVE_BAD_PAGE';end if;
  s.frontier:=s.frontier-0;
  v_anc:=array[s.claim->>'id']||array(select jsonb_array_elements_text(s.claim->'ancestors'));
  for f in select value from jsonb_array_elements(p_payload->'files') loop
   v_id:=f->>'id';v_path:=concat_ws(' / ',nullif(s.claim->>'path',''),f->>'name');
   if v_id=any(v_anc) then raise exception 'DRIVE_CYCLE';end if;
   if v_id is null or v_id !~ '^[A-Za-z0-9_-]{10,120}$' or length(f->>'name')>500 or length(v_path)>4000 or f->>'modifiedTime' is null then raise exception 'DRIVE_BAD_FILE';end if;
   if f->>'mimeType'='application/vnd.google-apps.shortcut' then continue;end if;
   if f->>'mimeType'='application/vnd.google-apps.folder' then
    if (s.claim->>'depth')::integer>=15 or jsonb_array_length(s.frontier)>=5000 then raise exception 'DRIVE_DEPTH_LIMIT';end if;
    if not exists(select 1 from jsonb_array_elements(s.frontier) x where x->>'id'=v_id) then s.frontier:=s.frontier||jsonb_build_array(jsonb_build_object('id',v_id,'path',v_path,'depth',(s.claim->>'depth')::integer+1,'ancestors',to_jsonb(v_anc),'page',''));end if;
   else
    v_modified:=(f->>'modifiedTime')::timestamptz;
    insert into public.drive_catalog_files(file_id,name,folder_path,mime_type,size_bytes,ancestor_ids,source_modified_at,seen_run)
    values(v_id,f->>'name',v_path,f->>'mimeType',nullif(f->>'size','')::bigint,v_anc,v_modified,r.id)
    on conflict(file_id) do update set name=excluded.name,folder_path=excluded.folder_path,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,ancestor_ids=excluded.ancestor_ids,source_modified_at=excluded.source_modified_at,seen_run=excluded.seen_run,present=true,indexed_at=now(),
     content_status=case when drive_catalog_files.source_modified_at=excluded.source_modified_at and drive_catalog_files.content_status not in ('error','changed') then drive_catalog_files.content_status else 'pending' end;
   end if;
  end loop;
  if coalesce(p_payload->>'nextPage','')<>'' then s.frontier:=jsonb_build_array(s.claim||jsonb_build_object('page',p_payload->>'nextPage'))||s.frontier;end if;
  update private.drive_catalog_sync set frontier=s.frontier where id;
  update public.drive_catalog_runs set pages=pages+1 where id=r.id;
 elsif p_operation='save_text' then
  if r.status<>'extracting' or not private.user_has_permission(p_user_id,'prices.purchase.view') then raise exception 'DRIVE_FORBIDDEN';end if;
  v_status:=p_payload->>'status';v_body:=coalesce(p_payload->>'text','');
  if v_status is null or v_status not in ('readable','needs_ocr','unsupported','error','changed','too_large') or length(v_body)>60000 then raise exception 'DRIVE_BAD_TEXT';end if;
  if v_status='readable' then
   insert into public.drive_catalog_text(file_id,source_modified_at,body,truncated) values(s.claim->>'id',(s.claim->>'modifiedTime')::timestamptz,v_body,coalesce((p_payload->>'truncated')::boolean,false))
   on conflict(file_id) do update set source_modified_at=excluded.source_modified_at,body=excluded.body,truncated=excluded.truncated,indexed_at=now();
  end if;
  update public.drive_catalog_files set content_status=v_status,text_indexed_at=now() where file_id=s.claim->>'id' and source_modified_at=(s.claim->>'modifiedTime')::timestamptz;
  get diagnostics v_count=row_count;if v_count<>1 then raise exception 'DRIVE_CHANGED';end if;
  update public.drive_catalog_runs set readable=readable+case when v_status='readable' then 1 else 0 end,unreadable=unreadable+case when v_status<>'readable' then 1 else 0 end where id=r.id;
 end if;
 update private.drive_catalog_sync set token=null,claim=null,lease_until=null where id;
 return jsonb_build_object('status',case when p_operation='fail' then 'failed' else r.status end,'runId',r.id);
end$$;
revoke all on function public.drive_catalog_sync_step(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.drive_catalog_sync_step(uuid,text,jsonb) to service_role;

create or replace function public.search_drive_catalog(p_query text,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare q tsquery;result jsonb;v_total bigint;
begin
 if p_query is null or length(p_query)>120 or p_offset<0 or p_offset>10000 then raise exception 'DRIVE_BAD_QUERY';end if;
 q:=plainto_tsquery('simple',translate(p_query,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'));
 select count(*) into v_total from public.drive_catalog_files f where to_tsvector('simple',translate(f.name||' '||f.folder_path,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'))@@q or exists(select 1 from public.drive_catalog_text t where t.file_id=f.file_id and t.search_vector@@q);
 select coalesce(jsonb_agg(x),'[]'::jsonb) into result from (
  select f.file_id as id,f.name,f.folder_path as path,f.mime_type as "mimeType",f.source_modified_at as "modifiedTime",f.ancestor_ids as ancestors,f.indexed_at as "indexedAt",f.content_status as "contentStatus"
  from public.drive_catalog_files f where to_tsvector('simple',translate(f.name||' '||f.folder_path,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'))@@q or exists(select 1 from public.drive_catalog_text t where t.file_id=f.file_id and t.search_vector@@q)
  order by f.name,f.file_id offset p_offset limit 20
 ) x;
 return jsonb_build_object('files',result,'total',v_total,'truncated',v_total>p_offset+20,'catalog',true,'ready',exists(select 1 from public.drive_catalog_runs where status in ('extracting','completed')));
end$$;
revoke all on function public.search_drive_catalog(text,integer) from public,anon,authenticated,service_role;
grant execute on function public.search_drive_catalog(text,integer) to authenticated;
NOTIFY pgrst,'reload schema';

create or replace function private.agent_clean_tools(p_tools jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare e jsonb;k text;v jsonb;params jsonb;entry jsonb;result jsonb:='[]'::jsonb;
begin
 if p_tools is null then return result;end if;
 if jsonb_typeof(p_tools)<>'array' or jsonb_array_length(p_tools)>30 then raise exception 'AGENT_BAD_REQUEST' using errcode='22023';end if;
 for e in select x from jsonb_array_elements(p_tools) x loop
  if jsonb_typeof(e)<>'object' then raise exception 'AGENT_BAD_REQUEST' using errcode='22023';end if;
  if exists(select 1 from jsonb_object_keys(e) x where x not in ('name','params','rows','truncated','ms','error'))
     or not (e ? 'name' and e ? 'params' and e ? 'rows' and e ? 'truncated' and e ? 'ms')
     or jsonb_typeof(e->'name')<>'string' or jsonb_typeof(e->'params')<>'object' or jsonb_typeof(e->'rows')<>'number'
     or jsonb_typeof(e->'truncated')<>'boolean' or jsonb_typeof(e->'ms')<>'number' then
   raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
  end if;
  if (e->>'name') not in ('find_shipments','get_shipment','get_shipment_vehicles','get_shipment_documents','get_document_extraction',
       'list_delayed_shipments','get_stock_status','find_products','find_drive_documents','get_drive_document','search_system','get_system_record','get_my_tasks','get_help','speech_to_text','unknown')
     or (e->>'rows') !~ '^(100|[0-9]{1,2})$' or (e->>'ms') !~ '^(120000|1[01][0-9]{4}|[0-9]{1,5})$'
     or (e ? 'error' and (jsonb_typeof(e->'error')<>'string' or (e->>'error') not in
       ('TOOL_CALL_LIMIT','UNKNOWN_TOOL','INVALID_PARAMS','PERMISSION_DENIED','TOOL_TIMEOUT','TOOL_ERROR'))) then
   raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
  end if;
  params:='{}'::jsonb;
  for k,v in select * from jsonb_each(e->'params') loop
   if k in ('query','product_query') and jsonb_typeof(v)='string' then
    params:=params||jsonb_build_object(k,coalesce(private.agent_clean_text(v#>>'{}',60),''));
   elsif k='drive_id' and jsonb_typeof(v)='string' and length(v#>>'{}')<=120 and ((v#>>'{}') ~ '^[A-Za-z0-9_-]{10,120}$' or v#>>'{}'='[скрыто]') then
    params:=params||jsonb_build_object(k,v);
   elsif k in ('status','type','filter','topic','date_kind','section','related_by') and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[a-z_]{1,40}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='warehouse_code' and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[A-Z_]{2,20}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='fields' and jsonb_typeof(v)='string' and length(v#>>'{}')<=200 and (v#>>'{}') ~ '^[a-z_]+(,[a-z_]+)*$' then
    params:=params||jsonb_build_object(k,v);
   elsif k in ('date','date_to') and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='duration_seconds' and jsonb_typeof(v)='number' and (v#>>'{}') ~ '^([0-9]|[1-5][0-9]|60)(\.[0-9])?$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='offset' and jsonb_typeof(v)='number' and (v#>>'{}') ~ '^(10000|[0-9]{1,4})$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='limit' and jsonb_typeof(v)='number' and (v#>>'{}') ~ '^([1-9]|1[0-9]|20)$' then
    params:=params||jsonb_build_object(k,v);
   elsif k in ('shipment_id','document_id','record_id','parent_id') and jsonb_typeof(v)='string'
     and (v#>>'{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    params:=params||jsonb_build_object(k,v);
   else
    raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
   end if;
  end loop;
  entry:=jsonb_build_object('name',e->'name','params',params,'rows',e->'rows','truncated',e->'truncated','ms',e->'ms');
  if e ? 'error' then entry:=entry||jsonb_build_object('error',e->'error');end if;
  result:=result||jsonb_build_array(entry);
 end loop;
 return result;
end$$;
revoke all on function private.agent_clean_tools(jsonb) from public,anon,authenticated,service_role;


