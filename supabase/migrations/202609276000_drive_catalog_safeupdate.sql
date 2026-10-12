-- Scope metadata reconciliation to the approved root. Compatible with Supabase safeupdate.
-- No source mutations, permission changes, or catalog reset.
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
   update public.drive_catalog_files set present=(seen_run=r.id) where root_id='1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm';
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

