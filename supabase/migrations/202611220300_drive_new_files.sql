-- New files in a shipment's Drive folder (2026-11-22, «Обновить из Drive»). A file row remembers when a folder check
-- first saw it. When a later check of an already checked folder finds a file Nexus did not know, the shipment's
-- responsible employee gets one notification per check (unless they ran the check themselves and saw the result).
-- The first check of a folder sends nothing: every file is new then, and the employee sees the list on the screen.
-- No file names, prices or document contents go into the notification. Google Drive is only read.
begin;

alter table public.shipment_drive_files add column if not exists first_seen_at timestamptz;
-- Rows of earlier checks stay without a date: they are not «new».
alter table public.shipment_drive_files alter column first_seen_at set default clock_timestamp();

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'deadline', 'overdue', 'approval_request', 'approval_decision', 'status_change', 'discrepancy',
  'low_shelf_life', 'document_uploaded', 'sync_error', 'system',
  'task_assigned', 'task_reassigned', 'stage_blocked', 'order_blocked', 'price_review', 'drive_new_files'));

create or replace function private.notify_drive_new_file()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_folder public.shipment_drive_folders%rowtype; v_shipment public.shipments%rowtype;
begin
  select * into v_folder from public.shipment_drive_folders where shipment_id = new.shipment_id;
  if not found or v_folder.checked_at is null then return null; end if;
  select * into v_shipment from public.shipments where id = new.shipment_id;
  if not found or v_shipment.responsible_user_id is null or v_shipment.responsible_user_id = (select auth.uid()) then return null; end if;
  -- The folder generation changes at the end of every check: one notification per check.
  perform private.notify(v_shipment.responsible_user_id, 'drive_new_files', 'Новые файлы в папке Google Drive',
    format('Поставка %s: при проверке папки Google Drive найдены новые файлы. Проверьте их и загрузите нужные документы.', v_shipment.shipment_number),
    'shipment_drive_folder', v_shipment.id, v_shipment.id, 'drive_new_files:' || v_shipment.id || ':' || v_folder.generation);
  return null;
end $$;
revoke all on function private.notify_drive_new_file() from public, anon, authenticated, service_role;
drop trigger if exists notify_drive_new_file on public.shipment_drive_files;
create trigger notify_drive_new_file after insert on public.shipment_drive_files
  for each row execute function private.notify_drive_new_file();

commit;
