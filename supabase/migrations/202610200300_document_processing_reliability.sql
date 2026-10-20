-- Durable status, not a new queue. Business completion remains the existing source receipt.
create table if not exists public.shipment_drive_operations (
 id uuid primary key,
 shipment_id uuid not null references public.shipments(id),
 kind text not null check(kind in('bind','scan','import')),
 file_id text not null default '' check(length(file_id)<=120),
 revision text not null default '' check(length(revision)<=30),
 state text not null check(state in('running','completed','failed','needs_action')),
 stage text not null check(stage in('checking','reading','downloading','storage','registering','finished')),
 attempt integer not null default 1 check(attempt>0),
 started_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 lease_until timestamptz not null default clock_timestamp()+interval '120 seconds',
 finished_at timestamptz,
 error_code text check(error_code in('SESSION_EXPIRED','ACCESS_DENIED','SOURCE_CHANGED','SOURCE_UNAVAILABLE','UNSUPPORTED','STORAGE_FAILED','SAVE_UNCERTAIN','INTERRUPTED')),
 actor_id uuid not null default auth.uid() references public.profiles(id)
);
create index if not exists drive_operation_shipment_idx on public.shipment_drive_operations(shipment_id,started_at desc);
create index if not exists drive_operation_actor_idx on public.shipment_drive_operations(actor_id);
alter table public.shipment_drive_operations enable row level security;
revoke all on public.shipment_drive_operations from public,anon,authenticated,service_role;
grant select,insert,update on public.shipment_drive_operations to authenticated;
drop policy if exists shipment_drive_operation_access on public.shipment_drive_operations;
create policy shipment_drive_operation_access on public.shipment_drive_operations to authenticated
 using(private.shipment_drive_allowed()) with check(private.shipment_drive_allowed());

create or replace function public.begin_shipment_drive_operation(p_id uuid,p_shipment_id uuid,p_kind text,p_file_id text default '',p_revision text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare previous public.shipment_drive_operations%rowtype;
begin
 if not private.shipment_drive_allowed() then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 if p_kind not in('bind','scan','import') then raise exception 'Некорректная операция'; end if;
 if p_kind='import' and (not private.has_permission('documents.create') or not private.has_permission('documents.update')) then
  raise exception 'Недостаточно прав' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('drive-operation:'||p_shipment_id::text,0));
 select * into previous from public.shipment_drive_operations where id=p_id for update;
 if found then
  if previous.shipment_id<>p_shipment_id or previous.kind<>p_kind or previous.file_id<>p_file_id or previous.revision<>p_revision then raise exception 'Идентификатор операции уже использован'; end if;
  if previous.state='completed' then return jsonb_build_object('action','completed','attempt',previous.attempt); end if;
  if previous.state='running' and previous.lease_until>clock_timestamp() then return jsonb_build_object('action','busy','attempt',previous.attempt); end if;
 end if;
 if exists(select 1 from public.shipment_drive_operations where shipment_id=p_shipment_id and id<>p_id and state='running' and lease_until>clock_timestamp()) then
  return jsonb_build_object('action','busy');
 end if;
 update public.shipment_drive_operations set state='needs_action',error_code='INTERRUPTED',finished_at=clock_timestamp(),updated_at=clock_timestamp()
 where shipment_id=p_shipment_id and state='running' and lease_until<=clock_timestamp();
 insert into public.shipment_drive_operations(id,shipment_id,kind,file_id,revision,state,stage)
 values(p_id,p_shipment_id,p_kind,p_file_id,p_revision,'running','checking')
 on conflict(id) do update set state='running',stage='checking',attempt=shipment_drive_operations.attempt+1,
 started_at=clock_timestamp(),updated_at=clock_timestamp(),lease_until=clock_timestamp()+interval '120 seconds',finished_at=null,error_code=null,actor_id=auth.uid()
 returning * into previous;
 return jsonb_build_object('action','run','attempt',previous.attempt);
end $$;

create or replace function public.record_shipment_drive_operation(p_id uuid,p_attempt integer,p_stage text,p_state text default 'running',p_error_code text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare op public.shipment_drive_operations%rowtype;
begin
 if not private.shipment_drive_allowed() then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 select * into op from public.shipment_drive_operations where id=p_id and attempt=p_attempt and actor_id=auth.uid() and state='running' for update;
 if not found or op.lease_until<=clock_timestamp() then raise exception 'Операция прервана. Проверьте сохранённый результат'; end if;
 if p_state='completed' then
  if op.kind='import' and not exists(select 1 from public.shipment_drive_files f where f.shipment_id=op.shipment_id and f.file_id=op.file_id and f.imported_revision=op.revision and f.imported_document_id is not null) then
   raise exception 'Нет сохранённой квитанции импорта';
  elsif op.kind='scan' and not exists(select 1 from public.shipment_drive_folders f where f.shipment_id=op.shipment_id and f.checked_at>=op.started_at) then
   raise exception 'Проверка папки не сохранена';
  elsif op.kind='bind' and not exists(select 1 from public.shipment_drive_folders f where f.shipment_id=op.shipment_id) then
   raise exception 'Привязка папки не сохранена';
  end if;
 end if;
 update public.shipment_drive_operations set stage=p_stage,state=p_state,error_code=p_error_code,
 updated_at=clock_timestamp(),lease_until=clock_timestamp()+interval '120 seconds',
 finished_at=case when p_state='running' then null else clock_timestamp() end
 where id=p_id;
end $$;
revoke all on function public.begin_shipment_drive_operation(uuid,uuid,text,text,text),
 public.record_shipment_drive_operation(uuid,integer,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.begin_shipment_drive_operation(uuid,uuid,text,text,text),
 public.record_shipment_drive_operation(uuid,integer,text,text,text) to authenticated;

-- Fence existing OCR leases: attempt_count alone is insufficient because explicit retries reset it.
alter table public.shipment_source_extractions add column if not exists ocr_lease_until timestamptz;
do $$declare definition text; marker text; replacement text;begin
 definition:=replace(pg_get_functiondef('public.begin_shipment_source_ocr(uuid,uuid,uuid,text,text,text,text,integer,integer,boolean)'::regprocedure),chr(13),'');
 marker:=$old$return jsonb_build_object('action','run','extraction_id',v_id,'status','pending','attempt',v_attempt);$old$;
 replacement:=$new$update public.shipment_source_extractions set processing_started_at=clock_timestamp(),ocr_lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds) where id=v_id;
 return jsonb_build_object('action','run','extraction_id',v_id,'status','pending','attempt',v_attempt,
 'lease_started_at',(select processing_started_at from public.shipment_source_extractions where id=v_id));$new$;
 if position(replacement in definition)=0 then
  if position(marker in definition)=0 then raise exception 'OCR claim changed: review lease integration'; end if;
  execute replace(definition,marker,replacement);
 end if;
end $$;
create or replace function public.finish_shipment_source_ocr_fenced(
 p_extraction_id uuid,p_lease_started_at timestamptz,p_status text,
 p_extracted_data jsonb default '{}'::jsonb,p_field_evidence jsonb default '{}'::jsonb,p_conflicts jsonb default '[]'::jsonb,
 p_error_message text default null,p_extractor_version text default 'ocr-v1',
 p_page_count integer default null,p_processing_ms integer default null,p_confidence numeric default null,p_source_kind text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare e public.shipment_source_extractions%rowtype;
begin
 if not private.has_permission('source_documents.extract') then raise exception 'Нет права распознавать исходные документы' using errcode='42501'; end if;
 if not private.has_permission('source_documents.ocr') then raise exception 'Нет права передавать документы на OCR' using errcode='42501'; end if;
 if not private.has_permission('shipments.view') or not private.has_permission('documents.view') then raise exception 'Нет доступа к поставке или документам' using errcode='42501'; end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id and status='pending' and requested_by=auth.uid();
 if not found then raise exception 'Распознавание не найдено, уже завершено или запущено другим пользователем'; end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id,true);
 select * into e from public.shipment_source_extractions where id=p_extraction_id for update;
 if p_lease_started_at is null or e.processing_started_at is distinct from p_lease_started_at then raise exception 'Попытка распознавания устарела. Проверьте сохранённый результат'; end if;
 return public.finish_shipment_source_ocr(p_extraction_id,p_status,p_extracted_data,p_field_evidence,p_conflicts,
 p_error_message,p_extractor_version,p_page_count,p_processing_ms,p_confidence,p_source_kind);
end $$;
-- Old worker requests cannot bypass fencing.
revoke all on function public.finish_shipment_source_ocr(uuid,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text) from public,anon,authenticated,service_role;
revoke all on function public.finish_shipment_source_ocr_fenced(uuid,timestamptz,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_shipment_source_ocr_fenced(uuid,timestamptz,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text) to authenticated;
