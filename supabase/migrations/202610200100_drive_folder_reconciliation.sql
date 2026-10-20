-- Only the existing session + server gateway may record a digest of downloaded bytes.
alter table public.shipment_drive_files add column if not exists checked_revision text;
alter table public.shipment_drive_files add column if not exists checked_checksum text
 check(checked_checksum ~ '^[a-f0-9]{64}$');

create or replace function public.check_shipment_drive_content(
 p_shipment_id uuid,p_file_id text,p_revision text,p_checksum text
) returns void language plpgsql security invoker set search_path='' as $$
begin
 if not private.shipment_drive_allowed() then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 if p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' then raise exception 'Некорректная контрольная сумма'; end if;
 perform 1 from public.shipment_drive_folders where shipment_id=p_shipment_id for update;
 update public.shipment_drive_files set checked_revision=p_revision,checked_checksum=p_checksum
 where shipment_id=p_shipment_id and file_id=p_file_id and present and revision=p_revision;
 if not found then raise exception 'Файл изменён. Повторите проверку папки'; end if;
end $$;

-- Reuse registration/link/receipt transaction. A link-only call cannot fall through to registration.
create or replace function public.link_shipment_drive_document(
 p_shipment_id uuid,p_file_id text,p_revision text,p_checksum text,p_document_id uuid,p_version_id uuid
) returns uuid language plpgsql security invoker set search_path='' as $$
declare source public.shipment_drive_files%rowtype; target public.documents%rowtype; result uuid;
begin
 if not private.shipment_drive_allowed() or not private.has_permission('documents.create')
 or not private.has_permission('documents.update') then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 perform 1 from public.shipment_drive_folders where shipment_id=p_shipment_id for update;
 select * into source from public.shipment_drive_files where shipment_id=p_shipment_id and file_id=p_file_id for update;
 if not found or not source.present or source.revision is distinct from p_revision
 or source.checked_revision is distinct from p_revision or source.checked_checksum is distinct from p_checksum
 or p_checksum is null then raise exception 'Файл изменён. Повторите проверку содержимого'; end if;
 perform pg_advisory_xact_lock(hashtextextended('shipment-drive:'||p_checksum,0));
 select * into target from public.documents where id=p_document_id and archived_at is null and status<>'rejected' for update;
 if not found then raise exception 'Документ недоступен. Обновите варианты'; end if;
 perform 1 from public.document_versions where id=p_version_id and document_id=p_document_id
 and is_current and version_number=target.current_version and checksum_sha256=p_checksum;
 if not found then raise exception 'Версия документа изменилась. Обновите варианты'; end if;
 if source.imported_document_id is not null and source.imported_document_id<>p_document_id then
  raise exception 'Связь уже изменена. Обновите варианты';
 end if;
 result:=public.import_shipment_drive_file(p_shipment_id,p_file_id,p_revision,p_checksum,p_document_id,
   target.document_type_id,null,null);
 if result is distinct from p_document_id then
  raise exception 'Найдено несколько совпадений. Требуется отдельная проверка';
 end if;
 -- Existing receipt must not silently reattach a deliberately removed link.
 if not exists(select 1 from public.document_links where document_id=result and entity_type='shipment'
   and entity_id=p_shipment_id and removed_at is null) then
  raise exception 'Связь снята. Требуется отдельная проверка';
 end if;
 return result;
end $$;
revoke all on function public.check_shipment_drive_content(uuid,text,text,text),
 public.link_shipment_drive_document(uuid,text,text,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.check_shipment_drive_content(uuid,text,text,text),
 public.link_shipment_drive_document(uuid,text,text,text,uuid,uuid) to authenticated;
