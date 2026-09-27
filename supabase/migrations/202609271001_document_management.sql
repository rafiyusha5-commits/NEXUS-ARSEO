-- Document management: document types, documents with versions, links to business
-- objects, document requirements, a private Storage bucket and RLS.
--
-- The migration is idempotent: every object is created with "if not exists",
-- "create or replace" or is dropped before re-creation, and seed rows never
-- overwrite changes made later by administrators.
--
-- Security model (details in docs/documents-module.md):
--   * every table has RLS; anon and service_role get no privileges on the new tables;
--   * authenticated gets column-level INSERT/UPDATE only on user-editable columns;
--     file columns, version numbers and archive columns are written by triggers or by
--     the archive_document() function only;
--   * no DELETE privilege on any table: documents are archived, links are soft-removed;
--   * storage paths are validated against documents/<document id>/<random>-<safe name>
--     and the stored file must belong to the current user;
--   * all changes go to public.audit_log through private.write_access_audit().

-- 1. Permissions ------------------------------------------------------------------

insert into public.permissions (code, module, action, name, description) values
  ('documents.create', 'documents', 'create', 'Документы: создание',
    'Регистрация документа и загрузка первой версии файла'),
  ('documents.update', 'documents', 'update', 'Документы: изменение',
    'Изменение реквизитов, загрузка новых версий, связи с объектами'),
  ('documents.archive', 'documents', 'archive', 'Документы: архивирование',
    'Архивирование документа без физического удаления'),
  ('documents.manage_types', 'documents', 'manage_types', 'Документы: типы',
    'Ведение справочника типов документов'),
  ('documents.manage_requirements', 'documents', 'manage_requirements', 'Документы: требования',
    'Настройка обязательных документов для процессов и этапов')
on conflict (code) do update
  set name = excluded.name, description = excluded.description;

update public.permissions
set name = 'Документы: просмотр',
    description = 'Просмотр реестра, карточек и скачивание файлов документов'
where code = 'documents.view';

-- Default grants follow docs/roles-permissions.md, section 11. "on conflict do nothing"
-- keeps any later change made by an administrator when the migration is re-run.
insert into public.role_permissions (role_id, permission_id, granted)
select role.id, permission.id, true
from public.app_roles role
join public.permissions permission on permission.code in (
  'documents.view', 'documents.create', 'documents.update',
  'documents.archive', 'documents.manage_types', 'documents.manage_requirements'
)
where
  (role.code in ('administrator', 'director'))
  or (role.code in ('executive_director', 'commercial_director', 'logistics_director',
                    'senior_logistics_manager', 'logistics_specialist', 'accountant')
      and permission.code in ('documents.view', 'documents.create', 'documents.update'))
  or (role.code = 'logistics_director' and permission.code = 'documents.manage_requirements')
on conflict (role_id, permission_id) do nothing;

-- 2. Tables -----------------------------------------------------------------------

create table if not exists public.document_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  name_ru text not null check (length(btrim(name_ru)) between 1 and 200),
  name_en text check (name_en is null or length(name_en) <= 200),
  name_kk text check (name_kk is null or length(name_kk) <= 200),
  category text not null check (category in (
    'commercial', 'shipping', 'customs', 'quality', 'contract',
    'returns', 'marking', 'other'
  )),
  is_required_by_default boolean not null default false,
  has_validity_period boolean not null default false,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  document_type_id uuid not null references public.document_types(id) on delete restrict,
  document_number text check (document_number is null or length(btrim(document_number)) between 1 and 120),
  title text not null check (length(btrim(title)) between 1 and 300),
  description text check (description is null or length(description) <= 4000),
  document_date date,
  valid_until date,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'under_review', 'approved', 'rejected')),
  language text check (language is null or language in ('ru', 'kk', 'en', 'other')),
  currency_id uuid references public.currencies(id) on delete restrict,
  amount numeric(16, 2) check (amount is null or amount >= 0),
  current_version integer not null default 0 check (current_version >= 0),
  original_filename text,
  mime_type text,
  file_size_bytes bigint,
  storage_bucket text not null default 'nexus-documents' check (storage_bucket = 'nexus-documents'),
  storage_path text,
  uploaded_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles(id) on delete restrict,
  archive_reason text,
  constraint documents_amount_requires_currency check (amount is null or currency_id is not null),
  constraint documents_validity_after_date
    check (valid_until is null or document_date is null or valid_until >= document_date),
  constraint documents_archive_fields_consistent check (
    (archived_at is null and archived_by is null and archive_reason is null)
    or (archived_at is not null and archived_by is not null and length(btrim(archive_reason)) > 0)
  )
);

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  storage_bucket text not null default 'nexus-documents' check (storage_bucket = 'nexus-documents'),
  storage_path text not null unique,
  original_filename text not null check (length(btrim(original_filename)) between 1 and 255),
  mime_type text not null check (mime_type in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png'
  )),
  file_size_bytes bigint not null check (file_size_bytes > 0 and file_size_bytes <= 4194304),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  comment text check (comment is null or length(comment) <= 1000),
  is_current boolean not null default true,
  uploaded_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  constraint document_versions_number_unique unique (document_id, version_number),
  constraint document_versions_path_format check (
    storage_path ~ '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
    and split_part(storage_path, '/', 2) = document_id::text
  )
);

create table if not exists public.document_links (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete restrict,
  entity_type text not null check (entity_type in (
    'shipment', 'shipment_transport', 'supplier', 'customer',
    'product', 'warehouse', 'contract', 'customer_return'
  )),
  entity_id uuid not null,
  link_role text not null default 'related' check (link_role in ('primary', 'related', 'supporting')),
  note text check (note is null or length(note) <= 500),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.profiles(id) on delete restrict,
  constraint document_links_removal_consistent check ((removed_at is null) = (removed_by is null))
);

create table if not exists public.document_requirements (
  id uuid primary key default gen_random_uuid(),
  document_type_id uuid not null references public.document_types(id) on delete restrict,
  applies_to text not null default 'shipment' check (applies_to in ('shipment', 'shipment_transport')),
  shipment_type text check (shipment_type is null or shipment_type in ('import', 'export', 'domestic_transfer')),
  process_template_id uuid references public.process_templates(id) on delete restrict,
  stage_id uuid references public.shipment_stages(id) on delete restrict,
  route_id uuid references public.routes(id) on delete restrict,
  is_mandatory boolean not null default true,
  due_days integer check (due_days is null or due_days between 0 and 365),
  due_description text check (due_description is null or length(due_description) <= 300),
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  notes text check (notes is null or length(notes) <= 1000),
  is_active boolean not null default true,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Indexes and duplicate protection ----------------------------------------------

create index if not exists documents_type_idx on public.documents(document_type_id);
create index if not exists documents_status_idx on public.documents(status) where archived_at is null;
create index if not exists documents_valid_until_idx on public.documents(valid_until)
  where archived_at is null and valid_until is not null;
create index if not exists documents_created_at_idx on public.documents(created_at desc);
create index if not exists documents_uploaded_by_idx on public.documents(uploaded_by);
create index if not exists documents_number_idx on public.documents(lower(document_number))
  where document_number is not null;

create unique index if not exists document_versions_one_current
  on public.document_versions(document_id) where is_current;
create unique index if not exists document_versions_same_file_once
  on public.document_versions(document_id, checksum_sha256) where checksum_sha256 is not null;
create index if not exists document_versions_checksum_idx
  on public.document_versions(checksum_sha256) where checksum_sha256 is not null;

create unique index if not exists document_links_active_unique
  on public.document_links(document_id, entity_type, entity_id) where removed_at is null;
create index if not exists document_links_entity_idx
  on public.document_links(entity_type, entity_id) where removed_at is null;

create unique index if not exists document_requirements_scope_unique
  on public.document_requirements (
    document_type_id, applies_to,
    coalesce(shipment_type, ''),
    coalesce(process_template_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(stage_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(route_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where is_active;
create index if not exists document_requirements_template_idx
  on public.document_requirements(process_template_id) where is_active;

-- 4. Helper functions -----------------------------------------------------------------

-- True when the document exists and is not archived. SECURITY DEFINER so that RLS on
-- documents does not hide the row from users who may create but not view documents.
create or replace function private.document_is_active(p_document_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.documents d
    where d.id = p_document_id and d.archived_at is null
  );
$$;

-- True when the current user registered the document in the current transaction
-- (created_at is set to now(), which is constant within a transaction). Lets users with
-- documents.create but without documents.update attach the first version and the
-- initial links inside register_document(), and nothing afterwards.
create or replace function private.is_own_new_document(p_document_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.documents d
    where d.id = p_document_id
      and d.uploaded_by = (select auth.uid())
      and d.archived_at is null
      and d.created_at = now()
  );
$$;

-- True when a Storage object is registered as a document version. SECURITY DEFINER so
-- that Storage policies do not depend on the caller's visibility of document_versions.
create or replace function private.is_registered_document_file(p_bucket text, p_path text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.document_versions v
    where v.storage_bucket = p_bucket and v.storage_path = p_path
  );
$$;

revoke execute on function private.document_is_active(uuid) from public;
revoke execute on function private.is_own_new_document(uuid) from public;
revoke execute on function private.is_registered_document_file(text, text) from public;
grant execute on function private.document_is_active(uuid) to authenticated;
grant execute on function private.is_own_new_document(uuid) to authenticated;
grant execute on function private.is_registered_document_file(text, text) to authenticated;

-- 5. Triggers -------------------------------------------------------------------------

-- New documents always start without a file, unarchived and owned by the caller.
create or replace function private.prepare_document_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.document_types t
    where t.id = new.document_type_id and t.is_active
  ) then
    raise exception 'Тип документа не найден или отключён';
  end if;
  new.uploaded_by := (select auth.uid());
  new.current_version := 0;
  new.original_filename := null;
  new.mime_type := null;
  new.file_size_bytes := null;
  new.storage_bucket := 'nexus-documents';
  new.storage_path := null;
  new.archived_at := null;
  new.archived_by := null;
  new.archive_reason := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists prepare_document_insert on public.documents;
create trigger prepare_document_insert
  before insert on public.documents
  for each row execute function private.prepare_document_insert();

create or replace function private.touch_document_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.document_type_id is distinct from old.document_type_id and not exists (
    select 1 from public.document_types t
    where t.id = new.document_type_id and t.is_active
  ) then
    raise exception 'Тип документа не найден или отключён';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_document_update on public.documents;
create trigger touch_document_update
  before update on public.documents
  for each row execute function private.touch_document_update();

-- Every document must have at least one file version when the transaction commits.
create or replace function private.assert_document_has_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.document_versions v where v.document_id = new.id) then
    raise exception 'Документ должен быть зарегистрирован вместе с файлом';
  end if;
  return null;
end;
$$;

drop trigger if exists documents_require_version on public.documents;
create constraint trigger documents_require_version
  after insert on public.documents
  deferrable initially deferred
  for each row execute function private.assert_document_has_version();

-- Prepares a new version: checks rights, assigns the next number, takes size and
-- MIME type from the uploaded Storage object (never from the client) and retires the
-- previous current version. SECURITY DEFINER because it must lock the parent row and
-- read storage.objects regardless of the caller's RLS; all checks are explicit below.
create or replace function private.prepare_document_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_object record;
begin
  select * into v_document
  from public.documents d
  where d.id = new.document_id
  for update;

  if not found then
    raise exception 'Документ не найден';
  end if;
  if v_document.archived_at is not null then
    raise exception 'Документ в архиве: новые версии запрещены';
  end if;

  if v_document.current_version = 0 then
    if not (
      (select private.has_permission('documents.create'))
      and v_document.uploaded_by = (select auth.uid())
    ) and not (select private.has_permission('documents.update')) then
      raise exception 'Недостаточно прав для загрузки файла документа';
    end if;
  elsif not (select private.has_permission('documents.update')) then
    raise exception 'Недостаточно прав для загрузки новой версии';
  end if;

  if new.storage_path is null
    or split_part(new.storage_path, '/', 1) <> 'documents'
    or split_part(new.storage_path, '/', 2) <> new.document_id::text then
    raise exception 'Недопустимый путь файла';
  end if;

  if to_regclass('storage.objects') is null then
    raise exception 'Supabase Storage недоступен: файл нельзя проверить';
  end if;

  execute
    'select o.metadata, o.owner_id from storage.objects o where o.bucket_id = $1 and o.name = $2'
    into v_object
    using 'nexus-documents', new.storage_path;

  if v_object is null then
    raise exception 'Файл не найден в хранилище nexus-documents';
  end if;
  if v_object.owner_id is distinct from (select auth.uid())::text then
    raise exception 'Файл загружен другим пользователем';
  end if;

  new.storage_bucket := 'nexus-documents';
  new.mime_type := coalesce(v_object.metadata ->> 'mimetype', new.mime_type);
  new.file_size_bytes := coalesce(
    (v_object.metadata ->> 'size')::bigint,
    (v_object.metadata ->> 'contentLength')::bigint,
    new.file_size_bytes
  );
  new.version_number := v_document.current_version + 1;
  new.is_current := true;
  new.uploaded_by := (select auth.uid());
  new.uploaded_at := now();

  update public.document_versions
  set is_current = false
  where document_id = new.document_id and is_current;

  return new;
end;
$$;

drop trigger if exists prepare_document_version on public.document_versions;
create trigger prepare_document_version
  before insert on public.document_versions
  for each row execute function private.prepare_document_version();

-- Copies the new current version into the document row used by the registry.
create or replace function private.apply_document_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.documents
  set current_version = new.version_number,
      original_filename = new.original_filename,
      mime_type = new.mime_type,
      file_size_bytes = new.file_size_bytes,
      storage_bucket = new.storage_bucket,
      storage_path = new.storage_path,
      updated_at = now()
  where id = new.document_id;
  return null;
end;
$$;

drop trigger if exists apply_document_version on public.document_versions;
create trigger apply_document_version
  after insert on public.document_versions
  for each row execute function private.apply_document_version();

-- Polymorphic link validation.
--
-- document_links.entity_id cannot have a regular foreign key because one column points
-- to different tables depending on entity_type. Instead:
--   1. entity_type is limited by a CHECK constraint to a fixed list;
--   2. this trigger maps every entity_type to exactly one table (no dynamic table
--      names from user input) and verifies that the row exists;
--   3. it runs as SECURITY INVOKER, so the lookup is subject to the caller's RLS:
--      a user can only link a document to an object he is allowed to see;
--   4. supplier/customer links also check the counterparty role;
--   5. customer_return is accepted only after the returns table exists.
-- Business objects are archived, not deleted, so links do not dangle in normal use;
-- docs/documents-module.md contains a query that finds links to missing objects.
create or replace function private.validate_document_link_target()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  case new.entity_type
    when 'shipment' then
      select exists (select 1 from public.shipments where id = new.entity_id) into v_found;
    when 'shipment_transport' then
      select exists (select 1 from public.shipment_transports where id = new.entity_id) into v_found;
    when 'supplier' then
      select exists (
        select 1 from public.counterparties
        where id = new.entity_id
          and roles && array['manufacturer', 'supplier', 'carrier', 'broker', 'printing_house']
      ) into v_found;
    when 'customer' then
      select exists (
        select 1 from public.counterparties
        where id = new.entity_id and 'customer' = any(roles)
      ) into v_found;
    when 'product' then
      select exists (select 1 from public.products where id = new.entity_id) into v_found;
    when 'warehouse' then
      select exists (select 1 from public.warehouses where id = new.entity_id) into v_found;
    when 'contract' then
      select exists (select 1 from public.contracts where id = new.entity_id) into v_found;
    when 'customer_return' then
      if to_regclass('public.customer_returns') is null then
        raise exception 'Возвраты ещё не реализованы: связь с возвратом недоступна';
      end if;
      execute 'select exists (select 1 from public.customer_returns where id = $1)'
        into v_found using new.entity_id;
    else
      raise exception 'Недопустимый тип связанного объекта: %', new.entity_type;
  end case;

  if not v_found then
    raise exception 'Связанный объект не найден или недоступен';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_document_link_target on public.document_links;
create trigger validate_document_link_target
  before insert on public.document_links
  for each row execute function private.validate_document_link_target();

create or replace function private.validate_document_requirement()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.stage_id is not null and new.process_template_id is not null and not exists (
    select 1 from public.shipment_stages s
    where s.id = new.stage_id and s.process_template_id = new.process_template_id
  ) then
    raise exception 'Этап не относится к выбранному шаблону процесса';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists validate_document_requirement on public.document_requirements;
create trigger validate_document_requirement
  before insert or update on public.document_requirements
  for each row execute function private.validate_document_requirement();

create or replace function private.touch_document_type()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_document_type on public.document_types;
create trigger touch_document_type
  before update on public.document_types
  for each row execute function private.touch_document_type();

revoke execute on function private.prepare_document_insert() from public;
revoke execute on function private.touch_document_update() from public;
revoke execute on function private.assert_document_has_version() from public;
revoke execute on function private.prepare_document_version() from public;
revoke execute on function private.apply_document_version() from public;
revoke execute on function private.validate_document_link_target() from public;
revoke execute on function private.validate_document_requirement() from public;
revoke execute on function private.touch_document_type() from public;

-- Audit: reuse the existing trigger function from phase 0.
do $$
declare
  t text;
begin
  foreach t in array array['document_types', 'documents', 'document_versions',
                           'document_links', 'document_requirements'] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I', t, t);
    execute format(
      'create trigger audit_%I_changes after insert or update on public.%I '
      'for each row execute function private.write_access_audit()', t, t);
  end loop;
end;
$$;

-- 6. RPC functions --------------------------------------------------------------------

-- Registers a document, its first version and links in one transaction.
-- SECURITY INVOKER: grants, RLS and triggers apply to the caller.
create or replace function public.register_document(
  p_document_id uuid,
  p_document_type_id uuid,
  p_title text,
  p_storage_path text,
  p_original_filename text,
  p_document_number text default null,
  p_description text default null,
  p_document_date date default null,
  p_valid_until date default null,
  p_language text default null,
  p_currency_id uuid default null,
  p_amount numeric default null,
  p_checksum_sha256 text default null,
  p_links jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_link jsonb;
begin
  if not (select private.has_permission('documents.create')) then
    raise exception 'Недостаточно прав для регистрации документа';
  end if;
  if jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_links, '[]'::jsonb)) > 20 then
    raise exception 'Некорректный список связей (не более 20)';
  end if;

  insert into public.documents (
    id, document_type_id, document_number, title, description,
    document_date, valid_until, language, currency_id, amount
  ) values (
    p_document_id, p_document_type_id, nullif(btrim(p_document_number), ''), btrim(p_title),
    nullif(btrim(p_description), ''), p_document_date, p_valid_until,
    p_language, p_currency_id, p_amount
  );

  insert into public.document_versions (document_id, storage_path, original_filename, checksum_sha256)
  values (p_document_id, p_storage_path, p_original_filename, p_checksum_sha256);

  for v_link in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    insert into public.document_links (document_id, entity_type, entity_id, link_role)
    values (
      p_document_id,
      v_link ->> 'entity_type',
      (v_link ->> 'entity_id')::uuid,
      coalesce(v_link ->> 'link_role', 'related')
    );
  end loop;

  return p_document_id;
end;
$$;

-- Archives a document. SECURITY DEFINER because archive columns are not writable by
-- authenticated users; the permission and the reason are checked explicitly.
create or replace function public.archive_document(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.has_permission('documents.archive')) then
    raise exception 'Недостаточно прав для архивирования документа';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Укажите причину архивирования';
  end if;

  update public.documents
  set archived_at = now(),
      archived_by = (select auth.uid()),
      archive_reason = btrim(p_reason)
  where id = p_document_id and archived_at is null;

  if not found then
    raise exception 'Документ не найден или уже находится в архиве';
  end if;
end;
$$;

-- Returns the current user's document permissions for the interface.
-- The database still enforces every rule through RLS; this only hides buttons.
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
    'archive', (select private.has_permission('documents.archive')),
    'manage_types', (select private.has_permission('documents.manage_types')),
    'manage_requirements', (select private.has_permission('documents.manage_requirements'))
  );
$$;

revoke execute on function public.register_document(uuid, uuid, text, text, text, text, text, date, date, text, uuid, numeric, text, jsonb) from public, anon;
revoke execute on function public.archive_document(uuid, text) from public, anon;
revoke execute on function public.my_document_permissions() from public, anon;
grant execute on function public.register_document(uuid, uuid, text, text, text, text, text, date, date, text, uuid, numeric, text, jsonb) to authenticated;
grant execute on function public.archive_document(uuid, text) to authenticated;
grant execute on function public.my_document_permissions() to authenticated;

-- 7. Privileges -----------------------------------------------------------------------

alter table public.document_types enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_links enable row level security;
alter table public.document_requirements enable row level security;

revoke all on public.document_types, public.documents, public.document_versions,
  public.document_links, public.document_requirements from anon, authenticated, service_role;

grant select on public.document_types, public.documents, public.document_versions,
  public.document_links, public.document_requirements to authenticated;

grant insert (code, name_ru, name_en, name_kk, category, is_required_by_default,
              has_validity_period, sort_order, is_active)
  on public.document_types to authenticated;
grant update (name_ru, name_en, name_kk, category, is_required_by_default,
              has_validity_period, sort_order, is_active)
  on public.document_types to authenticated;

grant insert (id, document_type_id, document_number, title, description, document_date,
              valid_until, language, currency_id, amount)
  on public.documents to authenticated;
grant update (document_type_id, document_number, title, description, document_date,
              valid_until, status, language, currency_id, amount)
  on public.documents to authenticated;

grant insert (document_id, storage_path, original_filename, checksum_sha256, comment)
  on public.document_versions to authenticated;

grant insert (document_id, entity_type, entity_id, link_role, note)
  on public.document_links to authenticated;
grant update (removed_at, removed_by) on public.document_links to authenticated;

grant insert (document_type_id, applies_to, shipment_type, process_template_id, stage_id,
              route_id, is_mandatory, due_days, due_description, conditions, notes, is_active)
  on public.document_requirements to authenticated;
grant update (is_mandatory, due_days, due_description, conditions, notes, is_active)
  on public.document_requirements to authenticated;

-- 8. RLS policies -----------------------------------------------------------------------

drop policy if exists "employees view document types" on public.document_types;
create policy "employees view document types" on public.document_types
  for select to authenticated
  using ((select private.is_employee()));

drop policy if exists "type managers create document types" on public.document_types;
create policy "type managers create document types" on public.document_types
  for insert to authenticated
  with check ((select private.has_permission('documents.manage_types')));

drop policy if exists "type managers update document types" on public.document_types;
create policy "type managers update document types" on public.document_types
  for update to authenticated
  using ((select private.has_permission('documents.manage_types')))
  with check ((select private.has_permission('documents.manage_types')));

drop policy if exists "document viewers see documents" on public.documents;
create policy "document viewers see documents" on public.documents
  for select to authenticated
  using ((select private.has_permission('documents.view')));

drop policy if exists "document creators register documents" on public.documents;
create policy "document creators register documents" on public.documents
  for insert to authenticated
  with check (
    (select private.has_permission('documents.create'))
    and uploaded_by = (select auth.uid())
  );

drop policy if exists "document editors update active documents" on public.documents;
create policy "document editors update active documents" on public.documents
  for update to authenticated
  using (archived_at is null and (select private.has_permission('documents.update')))
  with check (archived_at is null and (select private.has_permission('documents.update')));

drop policy if exists "document viewers see versions" on public.document_versions;
create policy "document viewers see versions" on public.document_versions
  for select to authenticated
  using ((select private.has_permission('documents.view')));

drop policy if exists "document uploaders add versions" on public.document_versions;
create policy "document uploaders add versions" on public.document_versions
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and (select private.document_is_active(document_id))
    and (
      (select private.has_permission('documents.update'))
      or (
        (select private.has_permission('documents.create'))
        and (select private.is_own_new_document(document_id))
      )
    )
  );

drop policy if exists "document viewers see links" on public.document_links;
create policy "document viewers see links" on public.document_links
  for select to authenticated
  using ((select private.has_permission('documents.view')));

drop policy if exists "document editors add links" on public.document_links;
create policy "document editors add links" on public.document_links
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.document_is_active(document_id))
    and (
      (select private.has_permission('documents.update'))
      or (
        (select private.has_permission('documents.create'))
        and (select private.is_own_new_document(document_id))
      )
    )
  );

drop policy if exists "document editors remove links" on public.document_links;
create policy "document editors remove links" on public.document_links
  for update to authenticated
  using (
    removed_at is null
    and (select private.document_is_active(document_id))
    and (select private.has_permission('documents.update'))
  )
  with check (
    removed_at is not null
    and removed_by = (select auth.uid())
    and (select private.has_permission('documents.update'))
  );

drop policy if exists "document viewers see requirements" on public.document_requirements;
create policy "document viewers see requirements" on public.document_requirements
  for select to authenticated
  using (
    (select private.has_permission('documents.view'))
    or (select private.has_permission('documents.manage_requirements'))
  );

drop policy if exists "requirement managers create requirements" on public.document_requirements;
create policy "requirement managers create requirements" on public.document_requirements
  for insert to authenticated
  with check (
    (select private.has_permission('documents.manage_requirements'))
    and created_by = (select auth.uid())
  );

drop policy if exists "requirement managers update requirements" on public.document_requirements;
create policy "requirement managers update requirements" on public.document_requirements
  for update to authenticated
  using ((select private.has_permission('documents.manage_requirements')))
  with check ((select private.has_permission('documents.manage_requirements')));

-- 9. Private Storage bucket and object policies -------------------------------------------
--
-- Runs only where the Supabase storage schema exists. Otherwise a notice is raised and
-- the bucket must be created manually (docs/documents-module.md).

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage schema not found: create the private bucket nexus-documents manually (docs/documents-module.md)';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'nexus-documents', 'nexus-documents', false, 4194304,
    array[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png'
    ]
  )
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists "nexus documents: read registered files" on storage.objects';
  execute $policy$
    create policy "nexus documents: read registered files" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'nexus-documents'
        and (
          (
            (select private.has_permission('documents.view'))
            and (select private.is_registered_document_file(bucket_id, name))
          )
          -- The uploader must see his own not yet registered object: Storage inserts
          -- with RETURNING, which PostgreSQL checks against SELECT policies.
          or (
            owner_id = (select auth.uid())::text
            and not (select private.is_registered_document_file(bucket_id, name))
          )
        )
      )
  $policy$;

  execute 'drop policy if exists "nexus documents: upload into document folder" on storage.objects';
  execute $policy$
    create policy "nexus documents: upload into document folder" on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'nexus-documents'
        and owner_id = (select auth.uid())::text
        and name ~ '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
        and (
          (select private.has_permission('documents.create'))
          or (select private.has_permission('documents.update'))
        )
      )
  $policy$;

  execute 'drop policy if exists "nexus documents: remove own unregistered upload" on storage.objects';
  execute $policy$
    create policy "nexus documents: remove own unregistered upload" on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'nexus-documents'
        and owner_id = (select auth.uid())::text
        and created_at > now() - interval '1 hour'
        and not (select private.is_registered_document_file(bucket_id, name))
      )
  $policy$;
end;
$$;

-- 10. Seed data ------------------------------------------------------------------------
-- Preliminary list; mandatory flags and requirements require ARSEO confirmation
-- (docs/open-questions.md, M4). Existing rows are never overwritten.

insert into public.document_types
  (code, name_ru, name_en, name_kk, category, is_required_by_default, has_validity_period, sort_order)
values
  ('invoice', 'Инвойс', 'Invoice', 'Инвойс', 'commercial', true, false, 10),
  ('specification', 'Спецификация', 'Specification', 'Спецификация', 'commercial', false, false, 20),
  ('packing_list', 'Упаковочный лист', 'Packing list', 'Буып-түю парағы', 'shipping', true, false, 30),
  ('cmr', 'CMR', 'CMR consignment note', 'CMR', 'shipping', true, false, 40),
  ('ttn', 'ТТН', 'Waybill (TTN)', 'ТТЖ', 'shipping', false, false, 50),
  ('snt', 'СНТ', 'Goods accompanying note (SNT)', 'ТІЖ', 'shipping', false, false, 60),
  ('waybill', 'Накладная', 'Delivery note', 'Жүкқұжат', 'shipping', false, false, 70),
  ('customs_document', 'Таможенный документ', 'Customs document', 'Кедендік құжат', 'customs', false, false, 80),
  ('certificate', 'Сертификат', 'Certificate', 'Сертификат', 'quality', false, true, 90),
  ('supplier_contract', 'Контракт с поставщиком', 'Supplier contract', 'Жеткізушімен келісімшарт', 'contract', false, true, 100),
  ('customer_contract', 'Контракт с клиентом', 'Customer contract', 'Клиентпен келісімшарт', 'contract', false, true, 110),
  ('guarantee_letter', 'Гарантийное письмо', 'Guarantee letter', 'Кепілдік хат', 'commercial', false, true, 120),
  ('return_document', 'Документ по возврату', 'Return document', 'Қайтару құжаты', 'returns', false, false, 130),
  ('marking_document', 'Документ по маркировке («Честный знак»)', 'Marking document (Chestny Znak)', 'Таңбалау құжаты', 'marking', false, false, 140),
  ('other', 'Прочий документ', 'Other document', 'Басқа құжат', 'other', false, false, 900)
on conflict (code) do nothing;

do $$
declare
  v_template uuid;
begin
  select id into v_template
  from public.process_templates
  where code = 'import_eu_kz' and version = 1;

  if v_template is null then
    return;
  end if;

  insert into public.document_requirements
    (document_type_id, applies_to, shipment_type, process_template_id, stage_id,
     is_mandatory, due_description, notes, created_by)
  select t.id, 'shipment', 'import', v_template, s.id, r.is_mandatory, r.due_description,
         'Предварительно, требует подтверждения ARSEO (вопрос М4)', null
  from (values
    ('invoice', 'documents_check', true, 'До завершения проверки документов'),
    ('packing_list', 'documents_check', true, 'До завершения проверки документов'),
    ('specification', 'documents_check', false, 'До завершения проверки документов'),
    ('certificate', 'documents_check', false, 'До завершения проверки документов'),
    ('cmr', 'dispatched', true, 'При отгрузке'),
    ('customs_document', 'customs_clearance', false, 'При таможенном оформлении')
  ) as r(type_code, stage_code, is_mandatory, due_description)
  join public.document_types t on t.code = r.type_code
  join public.shipment_stages s on s.process_template_id = v_template and s.code = r.stage_code
  where not exists (
    select 1 from public.document_requirements existing
    where existing.document_type_id = t.id
      and existing.process_template_id = v_template
      and existing.stage_id = s.id
  );
end;
$$;

comment on table public.document_types is 'Document type catalogue (RU/EN/KK names, category, default obligation)';
comment on table public.documents is 'Registered business documents; files live in the private Storage bucket nexus-documents';
comment on table public.document_versions is 'Append-only file versions of documents';
comment on table public.document_links is 'Links from documents to shipments, transports, counterparties, products, warehouses, contracts and returns';
comment on table public.document_requirements is 'Documents required for shipment processes, stages, shipment types or routes';
