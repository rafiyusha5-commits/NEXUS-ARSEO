-- Phase 3B: controlled review and approval of document versions.
-- Apply after 202609271001_document_management.sql.

insert into public.permissions (code, module, action, name, description) values
  ('documents.approve', 'documents', 'approve', 'Документы: согласование',
   'Отправка решения по документу: утвердить или отклонить')
on conflict (code) do update
set name = excluded.name, description = excluded.description;

insert into public.role_permissions (role_id, permission_id, granted)
select r.id, p.id, true
from public.app_roles r
join public.permissions p on p.code = 'documents.approve'
where r.code in ('administrator', 'director')
on conflict (role_id, permission_id) do nothing;

alter table public.approvals
  add column if not exists request_comment text,
  add column if not exists entity_version integer;

do $$ begin
  alter table public.approvals add constraint approvals_request_comment_length
    check (request_comment is null or length(request_comment) <= 1000);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.approvals add constraint approvals_comment_length
    check (comment is null or length(comment) <= 1000);
exception when duplicate_object then null; end $$;

create unique index if not exists approvals_one_pending_document
  on public.approvals(entity_id)
  where entity_type = 'document' and status = 'pending';

-- Keep the older shipment policies scoped to non-document approvals. Document rows
-- are created and decided only through the workflow functions below.
drop policy if exists "employees view approvals" on public.approvals;
create policy "employees view approvals" on public.approvals for select to authenticated
using (
  requested_by = (select auth.uid())
  or approver_user_id = (select auth.uid())
  or (entity_type <> 'document' and (select private.has_permission('shipments.approve')))
);

drop policy if exists "employees create approvals" on public.approvals;
create policy "employees create approvals" on public.approvals for insert to authenticated
with check (entity_type <> 'document' and requested_by = (select auth.uid()));

drop policy if exists "approvers update approvals" on public.approvals;
create policy "approvers update approvals" on public.approvals for update to authenticated
using (
  entity_type <> 'document'
  and (approver_user_id = (select auth.uid()) or (select private.has_permission('shipments.approve')))
);

-- Editors may change metadata, but only the workflow functions below change status.
revoke update (status) on public.documents from authenticated;

create or replace function public.submit_document_for_review(
  p_document_id uuid,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_approval_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Требуется авторизация'; end if;
  if not (select private.has_permission('documents.update')) then
    raise exception 'Недостаточно прав для отправки документа на согласование';
  end if;
  if p_comment is not null and length(p_comment) > 1000 then
    raise exception 'Комментарий не должен превышать 1000 символов';
  end if;

  select * into v_document from public.documents
  where id = p_document_id for update;
  if not found or v_document.archived_at is not null then raise exception 'Документ не найден или находится в архиве'; end if;
  if v_document.current_version < 1 then raise exception 'У документа нет файла'; end if;
  if v_document.status not in ('uploaded', 'rejected') then
    raise exception 'Документ нельзя отправить на согласование из текущего статуса';
  end if;

  insert into public.approvals(entity_type, entity_id, approver_role, requested_by,
                               status, request_comment, entity_version)
  values ('document', p_document_id, 'documents.approve', (select auth.uid()),
          'pending', nullif(btrim(p_comment), ''), v_document.current_version)
  returning id into v_approval_id;

  update public.documents set status = 'under_review', updated_at = now()
  where id = p_document_id;
  return v_approval_id;
end;
$$;

create or replace function public.decide_document_review(
  p_approval_id uuid,
  p_decision text,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.approvals%rowtype;
  v_document public.documents%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Требуется авторизация'; end if;
  if not (select private.has_permission('documents.approve')) then
    raise exception 'Недостаточно прав для согласования документа';
  end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Недопустимое решение'; end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'При отклонении укажите причину';
  end if;
  if p_comment is not null and length(p_comment) > 1000 then
    raise exception 'Комментарий не должен превышать 1000 символов';
  end if;

  select * into v_approval from public.approvals
  where id = p_approval_id and entity_type = 'document' for update;
  if not found or v_approval.status <> 'pending' then raise exception 'Запрос на согласование уже обработан или не найден'; end if;

  select * into v_document from public.documents
  where id = v_approval.entity_id for update;
  if not found or v_document.archived_at is not null then raise exception 'Документ не найден или находится в архиве'; end if;
  if v_document.status <> 'under_review' or v_document.current_version <> v_approval.entity_version then
    raise exception 'Версия документа изменилась; отправьте её на согласование заново';
  end if;

  update public.approvals
  set status = p_decision, approver_user_id = (select auth.uid()),
      decided_at = now(), comment = nullif(btrim(p_comment), '')
  where id = p_approval_id;
  update public.documents set status = p_decision, updated_at = now()
  where id = v_approval.entity_id;
  return v_approval.entity_id;
end;
$$;

-- A new file version invalidates an earlier decision and any pending request.
create or replace function private.apply_document_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.approvals
  set status = 'cancelled', decided_at = now(),
      comment = coalesce(comment, 'Отменено автоматически: загружена новая версия')
  where entity_type = 'document' and entity_id = new.document_id and status = 'pending';

  update public.documents
  set current_version = new.version_number,
      original_filename = new.original_filename,
      mime_type = new.mime_type,
      file_size_bytes = new.file_size_bytes,
      storage_bucket = new.storage_bucket,
      storage_path = new.storage_path,
      status = 'uploaded',
      updated_at = now()
  where id = new.document_id;
  return null;
end;
$$;

create or replace function public.my_document_permissions()
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'view', (select private.has_permission('documents.view')),
    'create', (select private.has_permission('documents.create')),
    'update', (select private.has_permission('documents.update')),
    'approve', (select private.has_permission('documents.approve')),
    'archive', (select private.has_permission('documents.archive')),
    'manage_types', (select private.has_permission('documents.manage_types')),
    'manage_requirements', (select private.has_permission('documents.manage_requirements'))
  );
$$;

drop policy if exists "document participants view approvals" on public.approvals;
create policy "document participants view approvals" on public.approvals
for select to authenticated
using (
  entity_type = 'document'
  and (
    requested_by = (select auth.uid())
    or approver_user_id = (select auth.uid())
    or (select private.has_permission('documents.view'))
  )
);

revoke execute on function public.submit_document_for_review(uuid, text) from public, anon;
revoke execute on function public.decide_document_review(uuid, text, text) from public, anon;
grant execute on function public.submit_document_for_review(uuid, text) to authenticated;
grant execute on function public.decide_document_review(uuid, text, text) to authenticated;
