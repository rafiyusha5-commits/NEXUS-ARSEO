-- Extend the durable receipts to the explicit byte-check and link-only actions.
alter table public.shipment_drive_operations drop constraint if exists shipment_drive_operations_kind_check;
alter table public.shipment_drive_operations add constraint shipment_drive_operations_kind_check check(kind in ('bind','scan','import','check','link'));
create or replace function public.begin_shipment_drive_operation(p_id uuid,p_shipment_id uuid,p_kind text,p_file_id text default '',p_revision text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare previous public.shipment_drive_operations%rowtype;
begin
 if not private.shipment_drive_allowed() then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 if p_kind not in('bind','scan','import','check','link') then raise exception 'Некорректная операция'; end if;
 if p_kind in ('import','link') and (not private.has_permission('documents.create') or not private.has_permission('documents.update')) then
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
  if op.kind in ('import','link') and not exists(select 1 from public.shipment_drive_files f where f.shipment_id=op.shipment_id and f.file_id=op.file_id and f.imported_revision=op.revision and f.imported_document_id is not null) then
   raise exception 'Нет сохранённой квитанции импорта';
  elsif op.kind='check' and not exists(select 1 from public.shipment_drive_files f where f.shipment_id=op.shipment_id and f.file_id=op.file_id and f.checked_revision=op.revision and f.checked_checksum is not null) then
   raise exception 'Проверка содержимого не сохранена';
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

