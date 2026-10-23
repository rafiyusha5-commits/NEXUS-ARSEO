-- Drive is read only. These tables store Nexus bindings/proposals, never business facts.
create or replace function private.shipment_drive_allowed() returns boolean
language sql stable security definer set search_path='' as $$
 select private.drive_gateway_allowed() and private.can_write_shipments('update')
 and private.has_permission('documents.view') and private.has_permission('documents.drive.view')
 and private.has_permission('prices.purchase.view')
$$;
revoke all on function private.shipment_drive_allowed() from public,anon,authenticated,service_role;
grant execute on function private.shipment_drive_allowed() to authenticated;

create table if not exists public.shipment_drive_folders (
 shipment_id uuid primary key references public.shipments(id),
 folder_id text not null check(folder_id ~ '^[A-Za-z0-9_-]{10,120}$'),
 folder_name text not null check(length(folder_name) between 1 and 255),
 generation uuid not null default gen_random_uuid(),
 checked_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null default auth.uid() references public.profiles(id)
);
create index if not exists shipment_drive_folders_creator_idx on public.shipment_drive_folders(created_by);
create table if not exists public.shipment_drive_files (
 shipment_id uuid not null references public.shipment_drive_folders(shipment_id),
 file_id text not null check(file_id ~ '^[A-Za-z0-9_-]{10,120}$'),
 name text not null check(length(name) between 1 and 255),
 path text not null check(length(path)<=2000),
 mime_type text not null check(length(mime_type) between 1 and 255),
 revision text not null check(revision ~ '^[0-9]{1,30}$'),
 size bigint check(size>=0),
 present boolean not null default true,
 imported_document_id uuid references public.documents(id),
 imported_revision text,
 imported_checksum text check(imported_checksum ~ '^[a-f0-9]{64}$'),
 primary key(shipment_id,file_id),
 check((imported_document_id is null)=(imported_revision is null)),
 check((imported_document_id is null)=(imported_checksum is null))
);
create index if not exists shipment_drive_files_document_idx on public.shipment_drive_files(imported_document_id);
alter table public.shipment_drive_folders enable row level security;
alter table public.shipment_drive_files enable row level security;
revoke all on public.shipment_drive_folders,public.shipment_drive_files from public,anon,authenticated,service_role;
grant select,insert,update on public.shipment_drive_folders,public.shipment_drive_files to authenticated;
drop policy if exists shipment_drive_folder_access on public.shipment_drive_folders;
create policy shipment_drive_folder_access on public.shipment_drive_folders to authenticated
 using((select private.shipment_drive_allowed())) with check((select private.shipment_drive_allowed()));
drop policy if exists shipment_drive_file_access on public.shipment_drive_files;
create policy shipment_drive_file_access on public.shipment_drive_files to authenticated
 using((select private.shipment_drive_allowed())) with check((select private.shipment_drive_allowed()));
drop trigger if exists audit_shipment_drive_folders on public.shipment_drive_folders;
create trigger audit_shipment_drive_folders after insert or update on public.shipment_drive_folders
 for each row execute function private.write_access_audit();

create or replace function public.bind_shipment_drive_folder(p_shipment_id uuid,p_folder_id text,p_name text)
returns void language plpgsql security invoker set search_path='' as $$
declare existing text;
begin
 if not private.shipment_drive_allowed() then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 if p_folder_id='1ffI_2N0F9Gy3N8r5XgNRv-hipmCl1ele' then raise exception 'Выберите папку отдельной поставки'; end if;
 perform pg_advisory_xact_lock(hashtextextended('shipment-drive-binding:'||p_shipment_id::text,0));
 perform 1 from public.shipments where id=p_shipment_id;
 if not found then raise exception 'Поставка недоступна'; end if;
 select folder_id into existing from public.shipment_drive_folders where shipment_id=p_shipment_id;
 if found then
  if existing<>p_folder_id then raise exception 'Папка уже привязана. Замена требует отдельной проверки'; end if;
  return;
 end if;
 insert into public.shipment_drive_folders(shipment_id,folder_id,folder_name) values(p_shipment_id,p_folder_id,p_name);
end $$;

create or replace function public.scan_shipment_drive_folder(p_shipment_id uuid,p_generation uuid,p_files jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare binding public.shipment_drive_folders%rowtype; item jsonb;
begin
 if not private.shipment_drive_allowed() then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 select * into binding from public.shipment_drive_folders where shipment_id=p_shipment_id for update;
 if not found or binding.generation is distinct from p_generation then raise exception 'Папка проверена в другом окне. Обновите страницу'; end if;
 if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files)>500 then raise exception 'Некорректный список файлов'; end if;
 if exists(select 1 from jsonb_array_elements(p_files) x group by x->>'file_id' having count(*)>1) then raise exception 'Повтор файла в проверке'; end if;
 update public.shipment_drive_files set present=false where shipment_id=p_shipment_id;
 for item in select * from jsonb_array_elements(p_files) loop
  insert into public.shipment_drive_files(shipment_id,file_id,name,path,mime_type,revision,size,present)
  values(p_shipment_id,item->>'file_id',item->>'name',item->>'path',item->>'mime_type',item->>'revision',(item->>'size')::bigint,true)
  on conflict(shipment_id,file_id) do update set name=excluded.name,path=excluded.path,mime_type=excluded.mime_type,
   revision=excluded.revision,size=excluded.size,present=true;
 end loop;
 update public.shipment_drive_folders set checked_at=clock_timestamp(),generation=gen_random_uuid() where shipment_id=p_shipment_id;
end $$;

-- Atomic document registration/link and source receipt. INVOKER keeps document/Storage RLS.
-- No calls to recognition, confirmation, stock or finance routines, no replacement versions.
create or replace function public.import_shipment_drive_file(
 p_shipment_id uuid,p_file_id text,p_revision text,p_checksum text,p_document_id uuid,p_type_id uuid,p_storage_path text,p_filename text default null
) returns uuid language plpgsql security invoker set search_path='' as $$
declare source public.shipment_drive_files%rowtype; existing record; result uuid;
begin
 if not private.shipment_drive_allowed() or not private.has_permission('documents.create')
 or not private.has_permission('documents.update') then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 if p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' then raise exception 'Некорректная контрольная сумма'; end if;
 -- Same lock order as scan; checksum lock also serializes imports into different shipments.
 perform 1 from public.shipment_drive_folders where shipment_id=p_shipment_id for update;
 select * into source from public.shipment_drive_files where shipment_id=p_shipment_id and file_id=p_file_id for update;
 if not found or not source.present or source.revision is distinct from p_revision then raise exception 'Файл изменён. Повторите проверку папки'; end if;
 if source.imported_document_id is not null then
  if source.imported_revision is distinct from p_revision or source.imported_checksum is distinct from p_checksum then
   raise exception 'Документ уже загружен. Изменения требуют отдельного согласования';
  end if;
  return source.imported_document_id;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('shipment-drive:'||p_checksum,0));
 select v.document_id,v.is_current,d.archived_at,d.document_type_id into existing
 from public.document_versions v join public.documents d on d.id=v.document_id
 where v.checksum_sha256=p_checksum order by v.is_current desc,v.uploaded_at desc limit 1;
 if found then
  if not existing.is_current or existing.archived_at is not null then raise exception 'Файл уже есть в истории документа. Проверьте его вручную'; end if;
  if existing.document_type_id is distinct from p_type_id then raise exception 'Файл уже зарегистрирован с другим типом. Проверьте тип документа'; end if;
  result:=existing.document_id;
  insert into public.document_links(document_id,entity_type,entity_id,link_role)
  values(result,'shipment',p_shipment_id,'related') on conflict(document_id,entity_type,entity_id) where removed_at is null do nothing;
 else
  result:=public.register_document(p_document_id,p_type_id,source.name,p_storage_path,coalesce(p_filename,source.name),
   p_description=>'Источник: Google Drive. Загружен для проверки; данные поставки не подтверждены автоматически.',
   p_checksum_sha256=>p_checksum,
   p_links=>jsonb_build_array(jsonb_build_object('entity_type','shipment','entity_id',p_shipment_id,'link_role','related')));
 end if;
 update public.shipment_drive_files set imported_document_id=result,imported_revision=p_revision,imported_checksum=p_checksum
 where shipment_id=p_shipment_id and file_id=p_file_id;
 return result;
end $$;
revoke all on function public.bind_shipment_drive_folder(uuid,text,text),public.scan_shipment_drive_folder(uuid,uuid,jsonb),public.import_shipment_drive_file(uuid,text,text,text,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.bind_shipment_drive_folder(uuid,text,text),public.scan_shipment_drive_folder(uuid,uuid,jsonb),public.import_shipment_drive_file(uuid,text,text,text,uuid,uuid,text,text) to authenticated;
